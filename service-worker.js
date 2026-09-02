// Service Worker - Mis Partituras
//
// IMPORTANTE sobre actualizaciones:
// - Aquí SOLO se cachean los archivos de la app (HTML, CSS, JS).
// - Las PARTITURAS viven en IndexedDB y NUNCA se tocan aquí.
//   IndexedDB es un almacenamiento separado e independiente del cache.
// - Al actualizar se descarga lo nuevo pero los datos del usuario
//   permanecen intactos.

const CACHE_NAME = 'partituras-v17';

// Los archivos core se precachean al instalar.
const CORE_ASSETS = [
    '/',
    '/index.html',
    '/css/styles.css',
    '/js/app.js',
    '/manifest.json',
    '/version.json',
    '/lib/pdfjs/pdf.min.js',
    '/lib/pdfjs/pdf.worker.min.js'
];

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

// Evento: fetch.
// Estrategia principal: NETWORK-FIRST con fallback a cache.
// - Siempre intenta la red primero (así llegan las actualizaciones).
// - Si no hay conexión, usa el cache (funciona offline).
// - Cuando responde de red, actualiza el cache para uso offline posterior.
// Esto garantiza que al abrir la app siempre se obtenga la versión más nueva.
self.addEventListener('fetch', event => {
    // Solo interceptar peticiones de la propia app (mismo origen)
    if (!event.request.url.startsWith(self.location.origin)) return;

    // Las peticiones a /lib/ (pdf.js) y archivos estáticos también se cachean.
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
