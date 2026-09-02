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
let renderToken = 0;       // identifica el renderizado más reciente para cancelar los anteriores

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
    // Mostrar la versión de la app en el encabezado (para diagnosticar la tablet)
    const headerVersionEl = document.getElementById('headerVersion');
    if (headerVersionEl) headerVersionEl.textContent = 'v' + APP_VERSION;
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
const APP_VERSION = '1.10.3';

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

    // Comprobar actualizaciones: al iniciar con popup, cada 5 min sin popup
    checkForUpdates(true);
    setInterval(() => checkForUpdates(false), VERSION_CHECK_INTERVAL);
}

// Comprueba si hay una versión nueva de la app disponible.
// Compara la versión local (APP_VERSION) con la más reciente del servidor
// (version.json).
// showModal=true: muestra el popup de alerta (solo al iniciar la app)
// showModal=false: solo muestra el botón "Actualizar" en settings (sin molestar)
let checkingUpdates = false;
async function checkForUpdates(showModal = false) {
    if (checkingUpdates) return;
    checkingUpdates = true;
    try {
        const cacheBust = '?t=' + Date.now();
        const res = await fetch('version.json' + cacheBust, { cache: 'no-store' });
        if (!res.ok) throw new Error('Sin conexión');
        const data = await res.json();
        const latest = data.version;
        const current = APP_VERSION;
        const updateBtn = document.getElementById('updateBtn');

        if (compareVersions(latest, current) > 0) {
            // Hay una versión nueva: mostrar botón "Actualizar" en settings
            if (updateBtn) {
                updateBtn.classList.remove('hidden');
                updateBtn.title = `v${current} → v${latest}`;
            }
            setUpdateStatus(`Nueva versión disponible: v${latest}`, '');
            // Solo mostrar el popup de alerta al iniciar (showModal=true)
            if (showModal && document.getElementById('updateModal').classList.contains('hidden')) {
                const shouldUpdate = await askToUpdate(current, latest);
                if (shouldUpdate) await performUpdate();
            }
        } else {
            // Ya se tiene la última versión
            if (updateBtn) updateBtn.classList.add('hidden');
            if (showModal) setUpdateStatus('', '');
        }
    } catch (e) {
        console.warn('No se pudo comprobar actualizaciones:', e);
    } finally {
        checkingUpdates = false;
    }
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

// Elementos de la pantalla de progreso de actualización
const progressScreen = document.getElementById('progressScreen');
const progressBar = document.getElementById('progressBar');
const progressStepEl = document.getElementById('progressStep');
const progressPercent = document.getElementById('progressPercent');
const progressDone = document.getElementById('progressDone');

// Actualiza la barra de progreso de la actualización
function setProgress(percent, stepText) {
    if (progressBar) progressBar.style.width = percent + '%';
    if (progressPercent) progressPercent.textContent = percent + '%';
    if (stepText && progressStepEl) progressStepEl.textContent = stepText;
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
    // Configuración de la partitura (por ahora vacía, pronto habrá opciones)
    document.getElementById('viewerSettingsBtn').addEventListener('click', () => {
        optionsMenu.classList.add('hidden');
        showToast('⚙️ Ajustes de la partitura (próximamente)');
    });
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
    document.getElementById('updateBtn').addEventListener('click', () => {
        if (confirm('Tu app se actualizará sin perder tus partituras.\n\n¿Continuar?')) {
            performUpdate();
        }
    });
    document.getElementById('resetAppBtn').addEventListener('click', () => {
        if (confirm('Esto limpiará los archivos temporales de la app.\n\nTus partituras NO se borran.\n\n¿Continuar?')) {
            performUpdate();
        }
    });
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

// Proceso de actualización unificado: limpia caches, desregistra el SW
// y recarga la app desde el servidor. Tus partituras (IndexedDB) NO se borran.
async function performUpdate() {
    const updateBtn = document.getElementById('updateBtn');
    if (updateBtn) updateBtn.disabled = true;
    setUpdateStatus('🔄 Actualizando la app...', '');
    try {
        if ('caches' in window) {
            const keys = await caches.keys();
            await Promise.all(keys.map(k => caches.delete(k)));
        }
        if ('serviceWorker' in navigator) {
            const regs = await navigator.serviceWorker.getRegistrations();
            await Promise.all(regs.map(r => r.unregister()));
            // Si el SW sigue controlando la página, liberarlo para no volver
            // a servir el código viejo desde el caché.
            if (navigator.serviceWorker.controller) {
                navigator.serviceWorker.controller.postMessage({ type: 'SKIP_WAITING' });
            }
        }
        setUpdateStatus('✅ Listo. Recargando la app...', 'success');
        // Forzar la carga completa desde el servidor con un parámetro nuevo
        // (evita que el service worker viejo devuelva el código en caché).
        setTimeout(() => {
            window.location.href = './index.html?fresh=' + Date.now();
        }, 1200);
    } catch (e) {
        console.error('Error al actualizar:', e);
        setUpdateStatus('⚠️ No se pudo actualizar. Cierra y vuelve a abrir la app.', 'error');
        if (updateBtn) updateBtn.disabled = false;
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
        // Cerrar el visor para no dejar la pantalla en negro
        viewer.classList.add('hidden');
        pdfDoc = null;
        currentSheet = null;
        history.pushState({ viewer: 'closed' }, '', '#');
    }
}

async function deleteSheet(id) {
    if (!confirm('¿Eliminar esta partitura?')) return;
    try {
        await dbDeleteSheet(id);
        sheets = await dbGetAllSheets();
        renderSheets();
    } catch (err) {
        console.error('Error al eliminar la partitura:', err);
        alert('No se pudo eliminar la partitura. Inténtalo de nuevo.');
    }
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

    // Marcar este renderizado como el más reciente. Si llega otro render
    // mientras este trabaja, el anterior se descarta para evitar que se pisen.
    const token = ++renderToken;

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

    // Si mientras esperábamos la página llegó otro render más reciente, paramos.
    if (token !== renderToken) return;

    currentPdfScale = scale;
    const viewport = page.getViewport({ scale });

    pdfCanvas.width = viewport.width;
    pdfCanvas.height = viewport.height;

    // Sincronizar el tamaño CSS con el renderizado real (para que el scroll
    // del contenedor conozca el tamaño real y el pan sea natural).
    pdfCanvas.style.width = viewport.width + 'px';
    pdfCanvas.style.height = viewport.height + 'px';
    pdfCanvas.style.transform = '';

    // Limpiar transformaciones previas del canvas
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, pdfCanvas.width, pdfCanvas.height);

    await page.render({ canvasContext: ctx, viewport }).promise;
    // Volver a comprobar: si hubo otro render mientras dibujábamos,
    // no actualizar la info de página para no pisar la vista correcta.
    if (token !== renderToken) return;
    pageInfo.textContent = `Página ${num} de ${pdfDoc.numPages}`;
}

function setZoomMode(mode) {
    return () => {
        zoomMode = mode;
        pdfCanvas.style.transform = '';
        pdfContainer.classList.toggle('zoomed', false);
        document.getElementById('fitBtn').classList.toggle('active', mode === 'fit');
        document.getElementById('actualBtn').classList.toggle('active', mode === 'actual');
        renderPage(currentPage).catch(err => console.error('Error al cambiar de modo de escala:', err));
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
// - Doble toque en el centro: abrir/cerrar el dock superior
function setupSwipeNavigation() {
    let touchCount = 0;
    let startDist = null;         // distancia inicial entre 2 dedos
    let startScale = 1;           // escala al comenzar el pinch
    let startX = null;            // para detectar toque/deslizamiento de 1 dedo
    let startY = null;
    let startTime = null;
    let moved = false;
    let wasMultiTouch = false;
    // Gestión del pinch zoom con punto focal:
    // trabajamos sobre la escala "base" al iniciar el pinch y redimensionamos
    // el canvas (CSS) manteniendo fijo el punto del documento bajo los dedos.
    let pinchBaseScale = 1;       // currentPdfScale al iniciar el pinch
    let focalScreenX = 0;         // punto focal en pantalla (rel. al contenedor)
    let focalScreenY = 0;
    let focalDocX = 0;            // punto del documento bajo los dedos (coords base)
    let focalDocY = 0;

    const SWIPE_THRESHOLD = 50;
    const TAP_MAX_MOVE = 20;      // píxeles máximos para considerarlo "toque" no deslizamiento
    const TAP_MAX_TIME = 500;     // ms máximos para que un toque sea válido
    const EDGE_WIDTH = 70;        // % de ancho lateral para el toque (izquierda/derecha)
    // Variables para detectar el doble toque que abre/cierra el dock
    let lastTapTime = 0;
    let lastTapX = 0;
    let lastTapY = 0;
    const DOUBLE_TAP_TIME = 1000;  // ms entre los dos toques para considerarlo doble
    const DOUBLE_TAP_MOVE = 50;    // píxeles máximos de separación entre los dos toques

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
            // Escala base del pinch = escala actual del canvas renderizado
            pinchBaseScale = currentPdfScale;
            // Punto focal: centro de los dedos en pantalla
            const crect = pdfContainer.getBoundingClientRect();
            const fpx = (e.touches[0].clientX + e.touches[1].clientX) / 2;
            const fpy = (e.touches[0].clientY + e.touches[1].clientY) / 2;
            focalScreenX = fpx - crect.left;   // rel. al contenedor
            focalScreenY = fpy - crect.top;
            // Punto del documento bajo los dedos (en píxeles del canvas, ya que
            // sin zoom el tamaño CSS coincide con el renderizado)
            focalDocX = fpx - crect.left;
            focalDocY = fpy - crect.top;
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
            // Zoom por PINCH con punto focal: redimensionamos el canvas (CSS) y
            // ajustamos el scroll para que el punto bajo los dedos no se mueva.
            zoomMode = 'custom';
            currentZoomScale = newScale;
            const scaleRatio = newScale / pinchBaseScale;
            // Punto focal actual: centro de los dos dedos en pantalla (rel. contenedor)
            const containerRect = pdfContainer.getBoundingClientRect();
            focalScreenX = ((e.touches[0].clientX + e.touches[1].clientX) / 2) - containerRect.left;
            focalScreenY = ((e.touches[0].clientY + e.touches[1].clientY) / 2) - containerRect.top;
            // Punto del documento que está bajo los dedos (coords del canvas base)
            focalDocX = focalScreenX + pdfContainer.scrollLeft;
            focalDocY = focalScreenY + pdfContainer.scrollTop;
            // Redimensionar el canvas a la nueva escala (el scroll ahora sí conoce
            // el tamaño real -> el pan con un dedo funciona de forma natural).
            pdfCanvas.style.width = (pdfCanvas.width * scaleRatio) + 'px';
            pdfCanvas.style.height = (pdfCanvas.height * scaleRatio) + 'px';
            pdfCanvas.style.transform = '';
            // Ajustar el scroll para mantener fijo el punto bajo los dedos
            pdfContainer.scrollLeft = focalDocX * scaleRatio - focalScreenX;
            pdfContainer.scrollTop = focalDocY * scaleRatio - focalScreenY;
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

            // Si hay zoom activo, un dedo desplaza la partitura (pan)
            const hasZoom = pdfContainer.classList.contains('zoomed');
            if (hasZoom) {
                e.preventDefault();
                pdfContainer.scrollLeft -= diffX;
                pdfContainer.scrollTop -= diffY;
                startX = e.touches[0].clientX;
                startY = e.touches[0].clientY;
                moved = true;
            }
        }
    }, { passive: false });

    pdfContainer.addEventListener('touchend', async (e) => {
        // Si terminó el gesto de zoom con dos dedos
        if (wasMultiTouch && e.touches.length === 0) {
            document.getElementById('fitBtn').classList.remove('active');
            document.getElementById('actualBtn').classList.remove('active');
            try {
                if (zoomMode === 'custom') {
                    // Re-render a la escala final para nitidez, preservando el
                    // punto focal (no saltar al centro).
                    await renderPage(currentPage);
                } else if (zoomMode === 'fit') {
                    await renderPage(currentPage);
                } else if (zoomMode === 'actual') {
                    await renderPage(currentPage);
                }
                pdfContainer.classList.toggle('zoomed', zoomMode === 'custom' && currentZoomScale > 1.01);
            } catch (err) {
                console.error('Error al renderizar tras el gesto:', err);
                // No dejar la pantalla en modo zoom si falló el renderizado
                pdfContainer.classList.toggle('zoomed', false);
            } finally {
                // Limpiar SIEMPRE el estado del gesto, aunque falle, para que
                // los toques normales sigan funcionando.
                wasMultiTouch = false;
                startDist = null;
                startX = null;
                startY = null;
            }
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
                lastTapTime = 0; // resetear detección de doble toque
                if (diffX > 0) changePage(1);
                else changePage(-1);
            } else if (!moved && elapsed < TAP_MAX_TIME && Math.abs(diffX) < TAP_MAX_MOVE && Math.abs(diffY) < TAP_MAX_MOVE) {
                // Toque simple: si es en el lado izquierdo -> ir hacia atrás,
                // si es en el lado derecho -> ir hacia adelante
                const tapX = e.changedTouches[0].clientX;
                const tapY = e.changedTouches[0].clientY;
                if (tapX < containerWidth * 0.30) {
                    changePage(-1);  // toque a la izquierda = página anterior
                } else if (tapX > containerWidth * 0.70) {
                    changePage(1);   // toque a la derecha = siguiente página
                } else {
                    // Toque en el centro: abrir/cerrar el dock con DOBLE toque
                    const now = Date.now();
                    const dt = now - lastTapTime;
                    const dx = tapX - lastTapX;
                    const dy = tapY - lastTapY;
                    const isDoubleTap = dt < DOUBLE_TAP_TIME &&
                                        dt > 0 &&
                                        Math.abs(dx) < DOUBLE_TAP_MOVE &&
                                        Math.abs(dy) < DOUBLE_TAP_MOVE;
                    if (isDoubleTap) {
                        toggleDock(); // doble toque: abrir/cerrar el dock
                        lastTapTime = 0; // resetear para no acumular
                    } else {
                        // Primer toque del posible doble
                        lastTapTime = now;
                        lastTapX = tapX;
                        lastTapY = tapY;
                    }
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
        lastTapTime = 0;
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
            if (e.clientX < containerWidth * 0.30) {
                changePage(-1);
            } else if (e.clientX > containerWidth * 0.70) {
                changePage(1);
            } else {
                // Centro: abrir/cerrar el dock con DOBLE clic
                if (e.detail >= 2) {
                    toggleDock();
                }
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
        renderPage(currentPage).catch(err => console.error('Error al cambiar de página:', err));
    }
}

// Service Worker: se registra una vez al inicio para poder detectar
// actualizaciones. La versión se controla desde setupUpdateNotifier().
function registerServiceWorker() {
    if ('serviceWorker' in navigator) {
        // Ruta RELATIVA (sin / inicial) para que funcione en la subcarpeta
        // de GitHub Pages (/partitura-app/) y en local.
        navigator.serviceWorker.register('service-worker.js')
            .then(reg => console.log('SW registered', reg.scope))
            .catch(err => console.error('SW error:', err));
    }
}
