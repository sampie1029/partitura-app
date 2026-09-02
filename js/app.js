// ========== IndexedDB Setup ==========
const DB_NAME = 'partituraDB';
const DB_VERSION = 1;
let db = null;

function openDB() {
    return new Promise((resolve, reject) => {
        if (db) return resolve(db);
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onupgradeneeded = (e) => {
            const database = e.target.result;
            if (!database.objectStoreNames.contains('sheets')) {
                const store = database.createObjectStore('sheets', { keyPath: 'id' });
                store.createIndex('name', 'name');
                store.createIndex('category', 'category');
            }
        };
        request.onsuccess = (e) => {
            db = e.target.result;
            resolve(db);
        };
        request.onerror = (e) => reject(e.target.error);
    });
}

function dbAddSheet(sheet) {
    return new Promise((resolve, reject) => {
        const tx = db.transaction('sheets', 'readwrite');
        tx.objectStore('sheets').add(sheet);
        tx.oncomplete = () => resolve();
        tx.onerror = (e) => reject(e.target.error);
    });
}

function dbGetAllSheets() {
    return new Promise((resolve, reject) => {
        const tx = db.transaction('sheets', 'readonly');
        const request = tx.objectStore('sheets').getAll();
        request.onsuccess = () => resolve(request.result || []);
        request.onerror = (e) => reject(e.target.error);
    });
}

function dbDeleteSheet(id) {
    return new Promise((resolve, reject) => {
        const tx = db.transaction('sheets', 'readwrite');
        tx.objectStore('sheets').delete(id);
        tx.oncomplete = () => resolve();
        tx.onerror = (e) => reject(e.target.error);
    });
}

// ========== Estado de la app ==========
let sheets = [];
let currentCategory = 'todos';
let currentSheet = null;
let pdfDoc = null;
let currentPage = 1;

// Elementos DOM
const sheetList = document.getElementById('sheetList');
const searchInput = document.getElementById('searchInput');
const viewer = document.getElementById('viewer');
const pdfContainer = document.getElementById('pdfContainer');
const pdfCanvas = document.getElementById('pdfCanvas');
const ctx = pdfCanvas.getContext('2d');
const pageInfo = document.getElementById('pageInfo');
const viewerTitle = document.getElementById('viewerTitle');
const addModal = document.getElementById('addModal');
const addError = document.getElementById('addError');

// Inicializar
document.addEventListener('DOMContentLoaded', async () => {
    // Configurar worker de pdf.js (local, funciona offline)
    pdfjsLib.GlobalWorkerOptions.workerSrc = 'lib/pdfjs/pdf.worker.min.js';

    setupEventListeners();
    await openDB();
    await migrateOldSheets();
    sheets = await dbGetAllSheets();
    renderSheets();
    registerServiceWorker();
    setupUpdateNotifier();
});

// ========== SISTEMA DE ACTUALIZACIONES ==========
// La app avisa al usuario cuando hay una versión nueva y le permite
// aplicarla sin perder sus partituras (que viven en IndexedDB y no se tocan).

// Versión de la app. CÁMBIALA cada vez que publiques cambios.
const APP_VERSION = '1.3.0';

const VERSION_CHECK_INTERVAL = 5 * 60 * 1000; // cada 5 minutos

// Mantiene el registro de la última versión instalada en este dispositivo
function getInstalledVersion() {
    return localStorage.getItem('appVersion') || null;
}

function setInstalledVersion(v) {
    try {
        localStorage.setItem('appVersion', v);
    } catch (e) {
        console.warn('No se pudo guardar la versión:', e);
    }
}

async function setupUpdateNotifier() {
    // Escuchar eventos del service worker para saber cuándo hay
    // una versión nueva en espera de activarse
    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.addEventListener('controllerchange', () => {
            // Tomó control una versión nueva -> ya aplicada
            setInstalledVersion(APP_VERSION);
            showToast('✅ Actualización aplicada. Tus partituras están a salvo.');
        });
    }

    // Modo de pruebas: si la URL trae ?simulate-update, simulamos
    // que el usuario tiene una versión anterior para ver el aviso.
    const params = new URLSearchParams(window.location.search);
    if (params.get('simulate-update')) {
        setInstalledVersion('0.0.0');
    }

    // Comprobar actualizaciones de forma periódica
    checkForUpdates();
    setInterval(checkForUpdates, VERSION_CHECK_INTERVAL);
}

// Comprueba si hay una versión nueva de la app disponible
async function checkForUpdates() {
    const installed = getInstalledVersion();

    if (installed !== APP_VERSION) {
        // Hay una versión distinta a la que el usuario tiene
        if (installed === null) {
            // Primera vez: registrar la versión y no molestar
            setInstalledVersion(APP_VERSION);
            return;
        }

        // El usuario ya tenía esta app antes y hay una versión nueva.
        // Preguntarle si quiere actualizar ahora.
        const shouldUpdate = await askToUpdate(installed, APP_VERSION);
        if (shouldUpdate) {
            await applyUpdate();
        } else {
            showToast('Podrás actualizar más tarde desde ⚙️');
        }
    }

    // Si ya tenemos la versión correcta, no hacer nada (la app está al día)
}

function askToUpdate(oldVersion, newVersion) {
    return new Promise((resolve) => {
        const modal = document.getElementById('updateModal');
        const versionInfo = document.getElementById('updateVersionInfo');
        if (versionInfo) {
            versionInfo.textContent = `v${oldVersion} → v${newVersion}`;
        }
        modal.classList.remove('hidden');

        // Asignar manejadores una sola vez cada vez que se abre
        const laterBtn = document.getElementById('updateLater');
        const nowBtn = document.getElementById('updateNow');

        const onLater = () => {
            cleanup();
            resolve(false);
        };
        const onNow = () => {
            cleanup();
            resolve(true);
        };
        const cleanup = () => {
            laterBtn.removeEventListener('click', onLater);
            nowBtn.removeEventListener('click', onNow);
            modal.classList.add('hidden');
        };

        laterBtn.addEventListener('click', onLater);
        nowBtn.addEventListener('click', onNow);
    });
}

// Aplica la actualización: recarga usando la versión nueva del cache
async function applyUpdate() {
    // Marcar la versión nueva como instalada ANTES de recargar,
    // para que al volver la página no vuelva a pedir actualizar.
    setInstalledVersion(APP_VERSION);
    showToast('🔄 Actualizando...');

    try {
        if ('serviceWorker' in navigator) {
            const reg = await navigator.serviceWorker.ready;
            // Descargar e instalar el service worker nuevo
            const updated = await reg.update();

            // Esperar a que tome control (con timeout por seguridad)
            await new Promise(resolve => {
                if (navigator.serviceWorker.controller) {
                    const onControl = () => {
                        navigator.serviceWorker.removeEventListener('controllerchange', onControl);
                        resolve();
                    };
                    navigator.serviceWorker.addEventListener('controllerchange', onControl);
                    // Timeout de seguridad: recargar de todas formas
                    setTimeout(resolve, 4000);
                } else {
                    resolve();
                }
            });
        }
    } catch (e) {
        console.error('Error al actualizar (se recarga igualmente):', e);
    }

    // Recarga completa: ahora el service worker nuevo controlará y
    // servirá la versión nueva de los archivos.
    window.location.reload();
}

// Pequeña notificación tipo "toast"
function showToast(message) {
    let toast = document.getElementById('toast');
    if (!toast) {
        toast = document.createElement('div');
        toast.id = 'toast';
        document.body.appendChild(toast);
    }
    toast.textContent = message;
    toast.classList.add('show');
    clearTimeout(toast._timer);
    toast._timer = setTimeout(() => toast.classList.remove('show'), 3500);
}

// ========== MIGRACIÓN DE DATOS ==========
// Migra automáticamente partituras guardadas con sistemas anteriores.
// Las partituras de la gente NUNCA se pierden al actualizar.

const STORAGE_KEYS = [
    'sheets',                     // sistema original (localStorage, base64)
    'partituras',                // reservado por si acaso
    'partituraDb',               // reservado por si acaso
];

async function migrateOldSheets() {
    // Detecta partituras guardadas con el sistema VIEJO (localStorage con base64)
    // y las convierte a Blob dentro de la versión actual.
    try {
        // 1) Buscar en localStorage
        for (const key of STORAGE_KEYS) {
            const raw = localStorage.getItem(key);
            if (!raw) continue;

            let oldSheets = [];
            try {
                oldSheets = JSON.parse(raw);
            } catch {
                continue; // no es JSON válido, no migrar
            }
            if (!Array.isArray(oldSheets) || oldSheets.length === 0) continue;

            // Convertir cada partitura vieja a formato nuevo
            let migrated = 0;
            for (const old of oldSheets) {
                if (!old || !old.id || !old.name) continue;
                // Solo migrar si todavía no existe en la nueva base
                const exists = await dbGetSheet(old.id);
                if (exists) continue;

                // El sistema viejo guardaba el archivo como dataURL base64
                if (old.data && typeof old.data === 'string' && old.data.startsWith('data:')) {
                    try {
                        const blob = dataURLtoBlob(old.data);
                        await dbAddSheet({
                            id: old.id,
                            name: old.name,
                            category: old.category || 'otros',
                            file: blob,
                            fileName: old.fileName || (old.name + '.pdf'),
                            added: old.added || new Date().toISOString(),
                            migrated: true,
                            migratedAt: new Date().toISOString()
                        });
                        migrated++;
                    } catch (e) {
                        console.warn('No se pudo migrar la partitura:', old.name, e);
                    }
                } else if (old.file instanceof Blob) {
                    // Ya es Blob, solo marcar como migrada
                    await dbAddSheet({
                        id: old.id,
                        name: old.name,
                        category: old.category || 'otros',
                        file: old.file,
                        fileName: old.fileName || (old.name + '.pdf'),
                        added: old.added || new Date().toISOString(),
                        migrated: true,
                        migratedAt: new Date().toISOString()
                    });
                    migrated++;
                }
            }

            // Ya migramos lo que había en esta clave
            if (migrated > 0) {
                console.log(`Migradas ${migrated} partituras desde "${key}"`);
            }
            // Limpiar la clave antigua para no volver a migrar
            try {
                localStorage.removeItem(key);
            } catch (e) {
                console.warn('No se pudo limpiar la clave antigua:', key);
            }
        }
    } catch (e) {
        // Nunca debe bloquear la app por un error de migración
        console.error('Error en la migración (no crítico):', e);
    }
}

// Convierte un dataURL base64 (ej: "data:application/pdf;base64,....") a un Blob
function dataURLtoBlob(dataURL) {
    const parts = dataURL.split(',');
    const mimeMatch = parts[0].match(/:(.*?);/);
    const mime = mimeMatch ? mimeMatch[1] : 'application/pdf';
    const b64 = parts[1] || '';
    const byteCharacters = atob(b64);
    const byteArrays = [];
    for (let offset = 0; offset < byteCharacters.length; offset += 512) {
        const slice = byteCharacters.slice(offset, offset + 512);
        const byteNumbers = new Array(slice.length);
        for (let i = 0; i < slice.length; i++) {
            byteNumbers[i] = slice.charCodeAt(i);
        }
        byteArrays.push(new Uint8Array(byteNumbers));
    }
    return new Blob(byteArrays, { type: mime });
}

function dbGetSheet(id) {
    return new Promise((resolve, reject) => {
        const tx = db.transaction('sheets', 'readonly');
        const request = tx.objectStore('sheets').get(id);
        request.onsuccess = () => resolve(request.result || null);
        request.onerror = (e) => reject(e.target.error);
    });
}

function setupEventListeners() {
    // Categorías
    document.querySelectorAll('.cat-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.cat-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            currentCategory = btn.dataset.category;
            renderSheets();
        });
    });

    // Búsqueda
    searchInput.addEventListener('input', renderSheets);

    // Visor
    document.getElementById('backBtn').addEventListener('click', closeViewer);
    document.getElementById('fullscreenBtn').addEventListener('click', toggleFullscreen);
    setupSwipeNavigation();

    // Modal
    document.getElementById('addBtn').addEventListener('click', openModal);
    document.getElementById('cancelAdd').addEventListener('click', closeModal);
    document.getElementById('confirmAdd').addEventListener('click', addSheet);

    // Cerrar modal al hacer clic fuera
    addModal.addEventListener('click', (e) => {
        if (e.target === addModal) closeModal();
    });

    // Mostrar nombre de archivo seleccionado
    document.getElementById('sheetFile').addEventListener('change', (e) => {
        const file = e.target.files[0];
        showAddError('');
    });
}

function openModal() {
    addError.textContent = '';
    addModal.classList.remove('hidden');
}

function closeModal() {
    addModal.classList.add('hidden');
    document.getElementById('sheetName').value = '';
    document.getElementById('sheetFile').value = '';
    addError.textContent = '';
}

function showAddError(msg) {
    addError.textContent = msg;
}

function renderSheets() {
    const search = searchInput.value.toLowerCase();
    const filtered = sheets.filter(s => {
        const matchCategory = currentCategory === 'todos' || s.category === currentCategory;
        const matchSearch = s.name.toLowerCase().includes(search);
        return matchCategory && matchSearch;
    });

    if (filtered.length === 0) {
        sheetList.innerHTML = `
            <div class="empty-state">
                <div class="icon">🎵</div>
                <p>No hay partituras aún</p>
                <p>Toca + para agregar una</p>
            </div>
        `;
        return;
    }

    sheetList.innerHTML = filtered.map(s => `
        <div class="sheet-card" onclick="openSheet('${s.id}')">
            <div class="icon">🎼</div>
            <div class="name">${escapeHtml(s.name)}</div>
            <div class="cat">${s.category}</div>
            <button class="delete-btn" onclick="event.stopPropagation(); deleteSheet('${s.id}')">×</button>
        </div>
    `).join('');
}

function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

async function addSheet() {
    const name = document.getElementById('sheetName').value.trim();
    const category = document.getElementById('sheetCategory').value;
    const fileInput = document.getElementById('sheetFile');

    if (!name) {
        showAddError('⚠️ Escribe un nombre para la partitura');
        return;
    }
    if (!fileInput.files.length) {
        showAddError('⚠️ Selecciona un archivo PDF');
        return;
    }

    const file = fileInput.files[0];
    if (!file.name.toLowerCase().endsWith('.pdf')) {
        showAddError('⚠️ El archivo debe ser un PDF');
        return;
    }

    // Mostrar estado de carga
    const confirmBtn = document.getElementById('confirmAdd');
    const originalText = confirmBtn.textContent;
    confirmBtn.disabled = true;
    confirmBtn.textContent = 'Guardando...';

    try {
        // Guardar el archivo directamente como Blob (no base64)
        const sheet = {
            id: Date.now().toString(),
            name,
            category,
            file: file,
            fileName: file.name,
            added: new Date().toISOString(),
            version: 2
        };

        await dbAddSheet(sheet);
        sheets = await dbGetAllSheets();
        closeModal();
        renderSheets();
    } catch (err) {
        console.error('Error al guardar:', err);
        showAddError('⚠️ Error al guardar. Intenta con otro archivo.');
    } finally {
        confirmBtn.disabled = false;
        confirmBtn.textContent = originalText;
    }
}

async function openSheet(id) {
    // Buscar en sheets en memoria que acaba de cargar
    currentSheet = sheets.find(s => s.id === id);
    if (!currentSheet) {
        // Si no está en memoria, buscarlo en la base de datos
        sheets = await dbGetAllSheets();
        currentSheet = sheets.find(s => s.id === id);
        if (!currentSheet) return;
    }

    viewerTitle.textContent = currentSheet.name;
    currentPage = 1;

    try {
        // Asegurarse de que el archivo es un Blob válido
        let fileData = currentSheet.file;
        if (fileData instanceof Blob) {
            const arrayBuffer = await fileData.arrayBuffer();
            viewer.classList.remove('hidden');
            pdfDoc = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
            await renderPage(currentPage);
        } else {
            throw new Error('Datos de archivo no válidos');
        }
    } catch (err) {
        console.error('Error al abrir PDF:', err);
        alert('Error al abrir la partitura. El archivo puede estar dañado.');
    }
}

async function deleteSheet(id) {
    if (!confirm('¿Eliminar esta partitura?')) return;
    await dbDeleteSheet(id);
    sheets = await dbGetAllSheets();
    renderSheets();
}

function closeViewer() {
    viewer.classList.add('hidden');
    if (currentSheet && currentSheet.url) {
        URL.revokeObjectURL(currentSheet.url);
    }
    pdfDoc = null;
    currentSheet = null;
}

async function renderPage(num) {
    if (!pdfDoc) return;

    const page = await pdfDoc.getPage(num);
    // Ajustar escala para que quepa en pantalla
    const baseViewport = page.getViewport({ scale: 1 });
    const maxWidth = pdfContainer.clientWidth - 20;
    const scale = Math.min(1.5, maxWidth / baseViewport.width);
    const viewport = page.getViewport({ scale });

    pdfCanvas.height = viewport.height;
    pdfCanvas.width = viewport.width;

    await page.render({ canvasContext: ctx, viewport }).promise;
    pageInfo.textContent = `Página ${num} de ${pdfDoc.numPages}`;
}

// Navegación por gestos: deslizar hacia la izquierda/derecha
// cambia de página. También se puede tocar en los lados de la pantalla.
function setupSwipeNavigation() {
    let startX = null;
    let startY = null;
    const SWIPE_THRESHOLD = 60; // píxeles mínimos para activar el gesto

    pdfContainer.addEventListener('touchstart', (e) => {
        if (e.touches.length === 1) {
            startX = e.touches[0].clientX;
            startY = e.touches[0].clientY;
        }
    }, { passive: true });

    pdfContainer.addEventListener('touchend', (e) => {
        if (startX === null) return;
        const endX = e.changedTouches[0].clientX;
        const endY = e.changedTouches[0].clientY;
        const diffX = startX - endX;
        const diffY = startY - endY;

        // Solo considerar deslizamiento horizontal claro
        if (Math.abs(diffX) > SWIPE_THRESHOLD && Math.abs(diffX) > Math.abs(diffY) * 1.5) {
            if (diffX > 0) {
                changePage(1);  // deslizar a la izquierda = siguiente página
            } else {
                changePage(-1); // deslizar a la derecha = página anterior
            }
            startX = null;
        }
    }, { passive: true });

    pdfContainer.addEventListener('touchcancel', () => {
        startX = null;
    }, { passive: true });

    // También soporte para ratón (pruebas en Mac)
    let mouseDownX = null;
    pdfContainer.addEventListener('mousedown', (e) => {
        mouseDownX = e.clientX;
    });
    pdfContainer.addEventListener('mouseup', (e) => {
        if (mouseDownX === null) return;
        const diffX = mouseDownX - e.clientX;
        if (Math.abs(diffX) > SWIPE_THRESHOLD) {
            if (diffX > 0) {
                changePage(1);
            } else {
                changePage(-1);
            }
        }
        mouseDownX = null;
    });
}

function changePage(delta) {
    if (!pdfDoc) return;
    const newPage = currentPage + delta;
    if (newPage >= 1 && newPage <= pdfDoc.numPages) {
        currentPage = newPage;
        renderPage(currentPage);
    }
}

function toggleFullscreen() {
    if (!document.fullscreenElement) {
        document.documentElement.requestFullscreen();
    } else {
        document.exitFullscreen();
    }
}

// Service Worker: se registra una vez al inicio para poder detectar
// actualizaciones. La versión se controla desde setupUpdateNotifier().
function registerServiceWorker() {
    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('/service-worker.js')
            .then(() => console.log('SW registered'))
            .catch(err => console.error('SW error:', err));
    }
}
