// Service Worker mínimo — solo necesario para que el navegador considere RADAR "instalable".
// No cachea agresivamente para no servir datos desactualizados de subvenciones/licitaciones.

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  self.clients.claim();
});

// Passthrough: deja pasar todas las peticiones a la red (sin caché offline),
// porque RADAR necesita datos siempre frescos de Supabase.
self.addEventListener('fetch', (event) => {
  event.respondWith(fetch(event.request));
});
