// escucharrr — service worker mínimo. Cachea SOLO el "shell" (HTML/CSS/JS/iconos) para arranque
// instantáneo y para que la app abra offline; los DATOS y el AUDIO siempre van a la red. Nunca
// intercepta /api/* (JSON dinámico, SSE /api/events, /api/stream por Range) — eso rompería el
// streaming y los eventos en vivo. Estrategias: navegación = red-primero con respaldo al shell;
// estáticos del shell = cache-primero revalidando en segundo plano (stale-while-revalidate).
const VERSION = 'esc-shell-v1';
const SHELL = [
  '/', '/app.html', '/styles.css', '/player.js', '/nav.js', '/icons.js', '/md.js',
  '/manifest.webmanifest', '/icon.svg', '/icon-maskable.svg'
];

self.addEventListener('install', (e) => {
  self.skipWaiting();
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL).catch(() => {})));
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;                       // nunca cacheamos mutaciones
  let url;
  try { url = new URL(req.url); } catch (_) { return; }
  if (url.origin !== self.location.origin) return;        // solo mismo origen
  if (url.pathname.startsWith('/api/')) return;           // DATOS/AUDIO/SSE → red directa, sin tocar

  // Navegaciones (barra de direcciones, "Añadir a inicio"): red primero; si no hay red, el shell.
  if (req.mode === 'navigate') {
    e.respondWith((async () => {
      try { return await fetch(req); }
      catch (_) { return (await caches.match('/app.html')) || (await caches.match('/')) || Response.error(); }
    })());
    return;
  }

  // Estáticos del shell: responde de cache al instante y revalida en segundo plano.
  e.respondWith((async () => {
    const cached = await caches.match(req);
    const net = fetch(req).then((res) => {
      if (res && res.ok && res.type === 'basic') { const copy = res.clone(); caches.open(VERSION).then((c) => c.put(req, copy)).catch(() => {}); }
      return res;
    }).catch(() => null);
    return cached || (await net) || Response.error();
  })());
});
