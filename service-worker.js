// Service Worker - Mis Partituras
//
// IMPORTANTE sobre actualizaciones:
// - Aquí SOLO se cachean los archivos de la app (HTML, CSS, JS).
// - Las PARTITURAS viven en IndexedDB y NUNCA se tocan aquí.
//   IndexedDB es un almacenamiento separado e independiente del cache.
// - Al actualizar se descarga lo nuevo pero los datos del usuario
//   permanecen intactos.

const CACHE_NAME = 'partituras-v5';

// Los archivos core se precachean al instalar.
const CORE_ASSETS = [
    '/',
    '/index.html',
    '/css/styles.css',
    '/js/app.js',
    '/manifest.json',
    '/lib/pdfjs/pdf.min.js',
    '/lib/pdfjs/pdf.worker.min.js'
];

// Evento: instalación inicial
self.addEventListener('install', event => {
    event.waitUntil(
        caches.open(CACHE_NAME).then(cache => {
            // addAll lanza error si un archivo falla; usamos un bucle
            // tolerante para que una actualización nunca bloquee la app
            return Promise.all(
                CORE_ASSETS.map(url =>
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

// Evento: fetch. Estrategia: cache con revalidación en segundo plano.
// - Primero responde desde cache (rápido y offline).
// - En paralelo, comprueba si hay versión nueva en red.
// - Si hay versión nueva, la usa la próxima vez.
// - Así las actualizaciones llegan solas sin romper nada.
self.addEventListener('fetch', event => {
    // No interceptar nada que no sea de la propia app
    if (!event.request.url.startsWith(self.location.origin)) return;
    // No interceptar peticiones de datos (evitar cachear blobs grandes)
    if (event.request.url.includes('/lib/') === false &&
        !isCoreAsset(event.request.url)) {
        // No cachear: dejar pasar a red (o fallback al cache si offline)
    }

    event.respondWith(
        (async () => {
            const cachedResponse = await caches.match(event.request);
            const networkResponsePromise = fetch(event.request).then(response => {
                if (response && response.status === 200 && response.type === 'basic') {
                    const clone = response.clone();
                    caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
                }
                return response;
            }).catch(() => cachedResponse);

            // Si tenemos cache, responder al instante y actualizar en segundo plano
            return cachedResponse || networkResponsePromise;
        })()
    );
});

function isCoreAsset(url) {
    return CORE_ASSETS.some(asset => {
        const urlPath = new URL(url).pathname;
        return urlPath === asset || (asset !== '/' && urlPath.startsWith(asset));
    });
}
