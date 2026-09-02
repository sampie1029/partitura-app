// Service Worker - Mis Partituras
//
// IMPORTANTE sobre actualizaciones:
// - Aquí SOLO se cachean los archivos de la app (HTML, CSS, JS).
// - Las PARTITURAS viven en IndexedDB y NUNCA se tocan aquí.
//   IndexedDB es un almacenamiento separado e independiente del cache.
// - Al actualizar se descarga lo nuevo pero los datos del usuario
//   permanecen intactos.

const CACHE_NAME = 'partituras-v25';

// Rutas relativas de los archivos core (se resuelven contra el scope del SW,
// que puede ser la raíz o una subcarpeta como /partitura-app/ en GitHub Pages).
const CORE_ASSET_PATHS = [
    './',
    './index.html',
    './css/styles.css',
    './js/app.js',
    './manifest.json',
    './version.json',
    './lib/pdfjs/pdf.min.js',
    './lib/pdfjs/pdf.worker.min.js'
];

// Resuelve una ruta relativa a una URL absoluta correcta basada en el scope.
function coreAssetUrls() {
    const scope = self.registration.scope;
    return CORE_ASSET_PATHS.map(p => new URL(p, scope).href);
}

// Evento: instalación inicial
// Forzar a que el nuevo service worker tome control
self.addEventListener('message', (event) => {
    if (!event.data || !event.data.type) return;
    if (event.data.type === 'SKIP_WAITING') {
        self.skipWaiting();
    } else if (event.data.type === 'PURGE_ALL') {
        // Limpiar TODOS los caches y recargar: actualización forzada
        event.waitUntil(
            caches.keys().then(names =>
                Promise.all(names.map(name => caches.delete(name)))
            ).then(() => {
                // Tomar control y notificar al cliente
                return self.clients.matchAll({ includeUncontrolled: true }).then(clients => {
                    clients.forEach(client => client.postMessage({ type: 'CACHE_PURGED' }));
                });
            })
        );
    }
});

self.addEventListener('install', event => {
    event.waitUntil(
        caches.open(CACHE_NAME).then(cache => {
            // addAll lanza error si un archivo falla; usamos un bucle
            // tolerante para que una actualización nunca bloquee la app
            return Promise.all(
                coreAssetUrls().map(url =>
                    cache.add(url).catch(() => console.warn('No cacheado:', url))
                )
            );
        })
    );
    // Forzar a que el nuevo service worker tome control
    self.skipWaiting();
});

// Evento: activación
self.addEventListener('activate', event => {
    event.waitUntil(
        Promise.all([
            // Limpiar caches viejos (solo afecta archivos de la app, no datos)
            caches.keys().then(names =>
                Promise.all(
                    names
                        .filter(name => name !== CACHE_NAME)
                        .map(name => caches.delete(name))
                )
            ),
            // Tomar control de las pestañas abiertas
            self.clients.claim()
        ])
    );
});

// Evento: fetch.
// Estrategia principal: NETWORK-FIRST con fallback a cache.
self.addEventListener('fetch', event => {
    // Solo interceptar peticiones de la propia app (mismo origen)
    if (!event.request.url.startsWith(self.location.origin)) return;

    // Las navegaciones (abrir la app) siempre intentan la red primero con un
    // timeout corto, para que al abrirla siempre se obtenga la versión más
    // nueva. Solo si no hay conexión se usa el cache (funciona offline).
    if (event.request.mode === 'navigate') {
        event.respondWith(fetchWithTimeout(event.request, 3000).catch(() => {
            return caches.match(event.request).then((cached) => cached || Response.error());
        }));
        return;
    }

    event.respondWith(
        (async () => {
            try {
                // Intentar red primero
                const networkResponse = await fetch(event.request);
                // Si es válida y del mismo origen, guardarla en cache
                if (networkResponse && networkResponse.status === 200 && networkResponse.type === 'basic') {
                    const clone = networkResponse.clone();
                    caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone)).catch(() => {});
                }
                return networkResponse;
            } catch (err) {
                // Fallo de red: usar cache (funciona offline)
                const cachedResponse = await caches.match(event.request);
                if (cachedResponse) return cachedResponse;
                // Si no hay cache, dejar pasar el error
                throw err;
            }
        })()
    );
});

// Helper: fetch con timeout (para la navegación)
function fetchWithTimeout(request, ms) {
    return new Promise((resolve, reject) => {
        const timeoutId = setTimeout(() => reject(new Error('timeout')), ms);
        fetch(request).then(
            (response) => { clearTimeout(timeoutId); resolve(response); },
            (err) => { clearTimeout(timeoutId); reject(err); }
        );
    });
}
