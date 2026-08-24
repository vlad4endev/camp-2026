/* Service worker для «Офлайн Кемп».
   Задача одна: чтобы страница открывалась в лагере, где интернета нет.

   Поднимите номер версии, если поменяли landing.html и хотите, чтобы
   у всех гарантированно подтянулась новая копия. */
const CACHE = 'offline-camp-v1';

const SHELL = [
  './',
  './landing.html',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png',
];

self.addEventListener('install', e => {
  // не роняем установку целиком, если один файл недоступен
  e.waitUntil(
    caches.open(CACHE)
      .then(c => Promise.allSettled(SHELL.map(u => c.add(u))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

/* Живые ответы сервера: занятость групп и данные лендинга. Их кэшировать
   нельзя — иначе телефон навсегда останется на числах и расписании того
   дня, когда его положили в кэш, и правка в штабе до него не доедет. */
const LIVE = new Set(['/seats', '/camp']);

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  if (LIVE.has(url.pathname)) return;          // мимо кэша, прямо в сеть

  /* stale-while-revalidate: сразу отдаём копию из кэша — в лагере сети нет,
     ждать таймаута запроса нельзя. Параллельно тихо тянем свежую версию,
     так правки объявлений подхватятся при следующем открытии. */
  e.respondWith(caches.open(CACHE).then(async cache => {
    // ignoreSearch — чтобы ?t=... и ?selftest тоже брались из кэша
    const cached = await cache.match(req, { ignoreSearch: true });
    const fresh = fetch(req)
      .then(res => { if (res && res.ok) cache.put(req, res.clone()); return res; })
      .catch(() => null);
    return cached
      || await fresh
      || new Response('Нет сети и нет сохранённой копии.', {
           status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  }));
});
