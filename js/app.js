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
let zoomMode = 'fit';      // 'fit' = escala completa (cabe en pantalla), 'actual' = escala real 1:1
let currentZoomScale = 1;  // escala usada cuando zoomMode es 'custom'
let currentPdfScale = 1;   // escala real con la que se renderizó la página actual

// Elementos DOM
const sheetList = document.getElementById('sheetList');
const searchInput = document.getElementById('searchInput');
const viewer = document.getElementById('viewer');
const pdfContainer = document.getElementById('pdfContainer');
const pdfCanvas = document.getElementById('pdfCanvas');
const ctx = pdfCanvas.getContext('2d');
const pageInfo = document.getElementById('pageInfo');
const viewerTitle = document.getElementById('viewerTitle');
const viewerDock = document.getElementById('viewerDock');
const optionsBtn = document.getElementById('optionsBtn');
const optionsMenu = document.getElementById('optionsMenu');
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
const APP_VERSION = '1.8.0';

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

// Aplica la actualización: descarga los archivos nuevos para que al
// reiniciar la app se cargue la versión nueva.
async function applyUpdate() {
    // Marcar la versión nueva como instalada ANTES de nada,
    // para que al volver la página no vuelva a pedir actualizar.
    setInstalledVersion(APP_VERSION);
    showToast('🔄 Descargando actualización...');

    try {
        if ('serviceWorker' in navigator) {
            const reg = await navigator.serviceWorker.ready;

            // Descargar el service worker nuevo (si existe)
            try { await reg.update(); } catch (e) { console.warn('update SW:', e); }

            // Forzar que el SW nuevo tome control
            if (reg.waiting) {
                reg.waiting.postMessage({ type: 'SKIP_WAITING' });
            }
        }
    } catch (e) {
        console.error('Error al actualizar:', e);
    }

    // Mostrar aviso de que se debe reiniciar la app para completar la
    // actualización. NO recargamos automáticamente para evitar el bucle
    // que impedía aplicar los cambios.
    alert('✅ Actualización descargada.\n\nPara que se aplique, cierra la app por completo y vuélvela a abrir.');
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
    document.getElementById('viewerSettingsBtn').addEventListener('click', openSettings);
    // Botón de opciones (⋯): desplegar/ocultar el mini menú
    document.getElementById('optionsBtn').addEventListener('click', (e) => {
        e.stopPropagation();
        optionsMenu.classList.toggle('hidden');
    });
    document.getElementById('fitBtn').addEventListener('click', () => {
        setZoomMode('fit')();
        optionsMenu.classList.add('hidden');
    });
    document.getElementById('actualBtn').addEventListener('click', () => {
        setZoomMode('actual')();
        optionsMenu.classList.add('hidden');
    });
    setupSwipeNavigation();

    // Cerrar el mini menú de opciones al hacer clic fuera de él
    document.addEventListener('click', (e) => {
        if (!optionsMenu.classList.contains('hidden') &&
            !optionsMenu.contains(e.target) &&
            e.target !== optionsBtn) {
            optionsMenu.classList.add('hidden');
        }
    });

    // Modal
    document.getElementById('addBtn').addEventListener('click', openModal);
    document.getElementById('cancelAdd').addEventListener('click', closeModal);
    document.getElementById('confirmAdd').addEventListener('click', addSheet);

    // Configuración
    document.getElementById('settingsBtn').addEventListener('click', openSettings);
    document.getElementById('backFromSettings').addEventListener('click', closeSettings);
    document.getElementById('checkUpdateBtn').addEventListener('click', manualCheckForUpdates);
    setupSettingsNav();

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

function openSettings() {
    // Llenar resumen
    document.getElementById('settingsVersion').textContent = `v${APP_VERSION}`;
    document.getElementById('aboutVersion').textContent = `v${APP_VERSION}`;
    updateSettingsSheetCount();
    updateSettingsStorage();

    // Registrar en el historial para que "atrás" cierre la configuración
    history.pushState({ settings: 'open' }, '', '#config');
    // Mostrar panel de resumen por defecto
    activateSettingsPanel('resumen');
    document.getElementById('settingsScreen').classList.remove('hidden');
}

function closeSettings() {
    document.getElementById('settingsScreen').classList.add('hidden');
}

function setupSettingsNav() {
    document.querySelectorAll('.settings-nav-item').forEach(btn => {
        btn.addEventListener('click', () => {
            const panel = btn.dataset.settings || 'resumen';
            activateSettingsPanel(panel);
        });
    });
}

function activateSettingsPanel(panelName) {
    // Actualizar botones del nav
    document.querySelectorAll('.settings-nav-item').forEach(b => b.classList.remove('active'));
    const activeBtn = document.querySelector(`.settings-nav-item[data-settings="${panelName === 'resumen' ? '' : panelName}"]`);
    if (activeBtn) activeBtn.classList.add('active');

    // Mostrar el panel correspondiente
    document.querySelectorAll('.settings-panel').forEach(p => p.classList.add('hidden'));
    let panelEl;
    if (panelName === 'resumen') {
        panelEl = document.querySelector('.settings-panel[data-panel="resumen"]');
    } else {
        panelEl = document.querySelector(`.settings-panel[data-panel="${panelName}"]`);
    }
    if (panelEl) panelEl.classList.remove('hidden');
}

async function updateSettingsSheetCount() {
    try {
        await openDB();
        const list = await dbGetAllSheets();
        document.getElementById('settingsSheetCount').textContent = list.length;
    } catch {
        document.getElementById('settingsSheetCount').textContent = '-';
    }
}

async function updateSettingsStorage() {
    try {
        let total = 0;
        if (navigator.storage && navigator.storage.estimate) {
            const est = await navigator.storage.estimate();
            total = est.usage || 0;
        }
        const sizeStr = total > 1048576 ? (total / 1048576).toFixed(1) + ' MB' : (total / 1024).toFixed(0) + ' KB';
        document.getElementById('settingsStorage').textContent = sizeStr;
        document.getElementById('storageUsage').textContent = sizeStr;
    } catch {
        document.getElementById('settingsStorage').textContent = '-';
        document.getElementById('storageUsage').textContent = '-';
    }
}

function setUpdateStatus(msg, type) {
    const status = document.getElementById('updateStatus');
    status.textContent = msg;
    status.className = 'settings-status' + (type ? ' ' + type : '');
}

async function manualCheckForUpdates() {
    const btn = document.getElementById('checkUpdateBtn');
    btn.disabled = true;
    setUpdateStatus('🔍 Buscando actualizaciones...', '');

    try {
        // Obtener la versión más reciente desde el servidor (GitHub Pages)
        const cacheBust = '?t=' + Date.now(); // evita cache
        const res = await fetch('version.json' + cacheBust, { cache: 'no-store' });
        if (!res.ok) throw new Error('No se pudo conectar');
        const data = await res.json();
        const latest = data.version;

        const current = APP_VERSION;

        if (compareVersions(latest, current) > 0) {
            // Hay una versión nueva disponible
            setUpdateStatus(`✅ Hay una versión nueva: v${latest} (tienes v${current})`, 'success');
            // Ofrecer actualizar
            const shouldUpdate = await askToUpdate(current, latest);
            if (shouldUpdate) {
                await applyUpdate();
            }
        } else {
            setUpdateStatus(`✅ Ya tienes la última versión (v${current})`, 'success');
        }
    } catch (e) {
        console.error('Error al buscar actualizaciones:', e);
        setUpdateStatus('⚠️ No se pudo comprobar (revisa tu conexión)', 'error');
    } finally {
        btn.disabled = false;
    }
}

// Compara dos versiones "x.y.z" -> devuelve >0 si a es mayor, 0 igual, <0 si menor
function compareVersions(a, b) {
    const pa = a.split('.').map(Number);
    const pb = b.split('.').map(Number);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const va = pa[i] || 0;
        const vb = pb[i] || 0;
        if (va > vb) return 1;
        if (va < vb) return -1;
    }
    return 0;
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
    // Al abrir una partitura, empezamos en escala completa
    zoomMode = 'fit';
    document.getElementById('fitBtn').classList.add('active');
    document.getElementById('actualBtn').classList.remove('active');
    // Modo inmersivo: dock oculto y menú cerrado
    viewerDock.classList.add('dock-hidden');
    optionsMenu.classList.add('hidden');

    try {
        // Asegurarse de que el archivo es un Blob válido
        let fileData = currentSheet.file;
        if (fileData instanceof Blob) {
            const arrayBuffer = await fileData.arrayBuffer();
            // Registrar en el historial para que el botón "atrás" de Android
            // vuelva al menú de partituras en lugar de cerrar la app.
            history.pushState({ viewer: 'open' }, '', '#partitura');
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
    pdfDoc = null;
    currentSheet = null;
}

// Manejar el botón "atrás" del navegador/Android
window.addEventListener('popstate', (e) => {
    if (!viewer.classList.contains('hidden')) {
        // Hay una partitura abierta: al pulsar atrás, cerramos el visor
        // y volvemos a la lista. No salimos de la app.
        e.preventDefault();
        closeViewer();
    } else if (!document.getElementById('settingsScreen').classList.contains('hidden')) {
        // Si hay configuraciones abiertas, cerrarlas también
        closeSettings();
    }
});

async function renderPage(num) {
    if (!pdfDoc) return;

    const page = await pdfDoc.getPage(num);
    const baseViewport = page.getViewport({ scale: 1 });
    let scale;

    if (zoomMode === 'fit') {
        // Escala completa: que ocupe todo el largo (alto) de la pantalla.
        // Como el dock se oculta en modo inmersivo, el alto disponible es
        // prácticamente toda la pantalla. Usamos el alto completo para que
        // no queden bordes negros arriba y abajo.
        const maxHeight = pdfContainer.clientHeight;
        const maxWidth = pdfContainer.clientWidth;
        // Priorizar llenar el alto: si no cabe en ancho, permitir desplazamiento
        const scaleHeight = maxHeight / baseViewport.height;
        const scaleWidth = maxWidth / baseViewport.width;
        scale = scaleHeight; // llena todo el alto
        // Si al llenar el alto se desborda el ancho, pasamos a modo desplazable
        pdfContainer.classList.toggle('zoomed', scale > scaleWidth);
    } else if (zoomMode === 'actual') {
        // Escala real 1:1
        scale = 1;
    } else {
        // Modo custom (zoom manual)
        scale = currentZoomScale;
    }

    currentPdfScale = scale;
    const viewport = page.getViewport({ scale });

    pdfCanvas.height = viewport.height;
    pdfCanvas.width = viewport.width;

    // Limpiar transformaciones previas del canvas
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, pdfCanvas.width, pdfCanvas.height);

    await page.render({ canvasContext: ctx, viewport }).promise;
    pageInfo.textContent = `Página ${num} de ${pdfDoc.numPages}`;
}

function setZoomMode(mode) {
    return () => {
        zoomMode = mode;
        pdfCanvas.style.transform = '';
        pdfContainer.classList.toggle('zoomed', false);
        document.getElementById('fitBtn').classList.toggle('active', mode === 'fit');
        document.getElementById('actualBtn').classList.toggle('active', mode === 'actual');
        renderPage(currentPage);
    };
}

// Muestra u oculta el dock superior del visor (modo inmersivo)
function toggleDock(force) {
    const show = (typeof force === 'boolean') ? force : viewerDock.classList.contains('dock-hidden');
    // Si vamos a ocultar, también ocultamos el menú de opciones
    if (!show) optionsMenu.classList.add('hidden');
    viewerDock.classList.toggle('dock-hidden', !show);
    return show;
}

// Gestos en el visor:
// - Un dedo: toque en la izquierda/derecha para cambiar de página
// - Dos dedos: abrir/cerrar (pinch) para hacer zoom
// - Deslizar con un dedo: también cambia de página
function setupSwipeNavigation() {
    let touchCount = 0;
    let startDist = null;         // distancia inicial entre 2 dedos
    let startScale = 1;           // escala al comenzar el pinch
    let startX = null;            // para detectar toque/deslizamiento de 1 dedo
    let startY = null;
    let startTime = null;
    let moved = false;
    let wasMultiTouch = false;

    const SWIPE_THRESHOLD = 50;
    const TAP_MAX_MOVE = 20;      // píxeles máximos para considerarlo "toque" no deslizamiento
    const TAP_MAX_TIME = 500;     // ms máximos para que un toque sea válido
    const EDGE_WIDTH = 70;        // % de ancho lateral para el toque (izquierda/derecha)

    pdfContainer.addEventListener('touchstart', (e) => {
        touchCount = e.touches.length;

        if (touchCount >= 2) {
            // Inicio del pinch (zoom con dos dedos)
            wasMultiTouch = true;
            touchCount = e.touches.length;
            const dx = e.touches[0].clientX - e.touches[1].clientX;
            const dy = e.touches[0].clientY - e.touches[1].clientY;
            startDist = Math.sqrt(dx * dx + dy * dy);
            startScale = zoomMode === 'fit' ? currentPdfScale : (zoomMode === 'actual' ? 1 : currentZoomScale);
        } else if (touchCount === 1) {
            // Inicio de un gesto de un dedo (toque o deslizamiento)
            if (!wasMultiTouch) {
                startX = e.touches[0].clientX;
                startY = e.touches[0].clientY;
                startTime = Date.now();
                moved = false;
            }
        }
    }, { passive: true });

    pdfContainer.addEventListener('touchmove', (e) => {
        // Zoom con dos dedos
        if (e.touches.length >= 2 && startDist !== null) {
            const dx = e.touches[0].clientX - e.touches[1].clientX;
            const dy = e.touches[0].clientY - e.touches[1].clientY;
            const dist = Math.sqrt(dx * dx + dy * dy);
            const ratio = dist / startDist;
            const newScale = Math.max(0.3, Math.min(4, startScale * ratio));
            // Aplicar zoom dinámico vía transform CSS (fluido, sin re-render)
            zoomMode = 'custom';
            currentZoomScale = newScale;
            pdfCanvas.style.transform = `scale(${newScale / currentPdfScale})`;
            pdfCanvas.style.transformOrigin = 'center center';
            // Permitir desplazamiento si la escala es mayor que 1
            pdfContainer.classList.toggle('zoomed', newScale > 1.01);
            // Marcar como gesto de zoom para no cambiar de página
            wasMultiTouch = true;
        } else if (e.touches.length === 1 && startX !== null) {
            // Desplazamiento de un dedo
            const diffX = e.touches[0].clientX - startX;
            const diffY = e.touches[0].clientY - startY;
            if (Math.abs(diffX) > Math.abs(diffY) && Math.abs(diffX) > TAP_MAX_MOVE) {
                moved = true;
            }
        }
    }, { passive: true });

    pdfContainer.addEventListener('touchend', async (e) => {
        // Si terminó el gesto de zoom con dos dedos
        if (wasMultiTouch && e.touches.length === 0) {
            // Resetear transform y re-renderizar al tamaño final (nitidez)
            pdfCanvas.style.transform = '';
            document.getElementById('fitBtn').classList.remove('active');
            document.getElementById('actualBtn').classList.remove('active');
            // Re-render a la escala final una sola vez (no por movimiento)
            if (zoomMode === 'custom') {
                await renderPage(currentPage);
            }
            pdfContainer.classList.toggle('zoomed', zoomMode === 'custom' && currentZoomScale > 1.01);
            wasMultiTouch = false;
            startDist = null;
            startX = null;
            startY = null;
            return;
        }

        // Manejar gesto de un dedo (toque o deslizamiento)
        if (startX !== null && !wasMultiTouch) {
            const endX = e.changedTouches[0].clientX;
            const endY = e.changedTouches[0].clientY;
            const diffX = startX - endX;
            const diffY = startY - endY;
            const elapsed = Date.now() - startTime;
            const containerWidth = pdfContainer.clientWidth;

            if (Math.abs(diffX) > SWIPE_THRESHOLD && Math.abs(diffX) > Math.abs(diffY) * 1.5) {
                // Deslizamiento horizontal: cambiar de página
                if (diffX > 0) changePage(1);
                else changePage(-1);
            } else if (!moved && elapsed < TAP_MAX_TIME && Math.abs(diffX) < TAP_MAX_MOVE && Math.abs(diffY) < TAP_MAX_MOVE) {
                // Toque simple: si es en el lado izquierdo -> ir hacia atrás,
                // si es en el lado derecho -> ir hacia adelante
                const tapX = e.changedTouches[0].clientX;
                if (tapX < containerWidth * 0.35) {
                    changePage(-1);  // toque a la izquierda = página anterior
                } else if (tapX > containerWidth * 0.65) {
                    changePage(1);   // toque a la derecha = siguiente página
                } else {
                    // Toque en el centro: mostrar/ocultar el dock
                    toggleDock();
                }
            }

            startX = null;
            startY = null;
            moved = false;
        }
    }, { passive: true });

    pdfContainer.addEventListener('touchcancel', () => {
        startX = null;
        startY = null;
        startDist = null;
        wasMultiTouch = false;
        moved = false;
    }, { passive: true });

    // Soporte para ratón (pruebas en Mac): toque/deslizamiento
    let mouseDownX = null;
    let mouseDownY = null;
    let mouseMoved = false;
    pdfContainer.addEventListener('mousedown', (e) => {
        mouseDownX = e.clientX;
        mouseDownY = e.clientY;
        mouseMoved = false;
    });
    pdfContainer.addEventListener('mousemove', (e) => {
        if (mouseDownX !== null) {
            const dx = Math.abs(e.clientX - mouseDownX);
            const dy = Math.abs(e.clientY - mouseDownY);
            if (dx > TAP_MAX_MOVE || dy > TAP_MAX_MOVE) mouseMoved = true;
        }
    });
    pdfContainer.addEventListener('mouseup', (e) => {
        if (mouseDownX === null) return;
        const diffX = mouseDownX - e.clientX;
        const diffY = mouseDownY - e.clientY;
        const containerWidth = pdfContainer.clientWidth;

        if (!mouseMoved) {
            // Toque de ratón: zonas laterales / centro
            if (e.clientX < containerWidth * 0.35) {
                changePage(-1);
            } else if (e.clientX > containerWidth * 0.65) {
                changePage(1);
            } else {
                toggleDock();
            }
        } else if (Math.abs(diffX) > SWIPE_THRESHOLD && Math.abs(diffX) > Math.abs(diffY) * 1.5) {
            if (diffX > 0) changePage(1);
            else changePage(-1);
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

// Service Worker: se registra una vez al inicio para poder detectar
// actualizaciones. La versión se controla desde setupUpdateNotifier().
function registerServiceWorker() {
    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('/service-worker.js')
            .then(() => console.log('SW registered'))
            .catch(err => console.error('SW error:', err));
    }
}
