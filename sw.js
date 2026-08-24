/* Service worker для «Офлайн Кемп».
   Задача одна: чтобы страница открывалась в лагере, где интернета нет.

   Поднимите номер версии, если поменяли landing.html и хотите, чтобы
   у всех гарантированно подтянулась новая копия. */
const CACHE = 'offline-camp-v2';   // v2: из кэша выселены дверь и панели

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

/* Кэшируем ТОЛЬКО оболочку лендинга — список SHELL и ничего сверх него.
   Раньше было наоборот («всё, кроме /seats и /camp»), и это ломало вход:
   scope воркера — весь сайт, значит под кэш попадали и /admin/, и
   /whoami. Ответы там зависят от куки, а воркер куку не понимает — он
   отдавал снимок. До входа в кэш ложилась дверь по адресу /admin/, после
   входа навигация получала из кэша всё ту же дверь, дверь по /whoami
   видела «вошёл» и возвращала на /admin/ — бесконечная петля обновлений.
   Дверь, панели и ответы сервера ходят в сеть напрямую: без сети панели
   и так открывают файлом с диска, офлайн нужен только лендингу. */
const SHELL_PATHS = new Set(SHELL.map(u => new URL(u, location).pathname));

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  if (!SHELL_PATHS.has(url.pathname)) return;  // мимо кэша, прямо в сеть

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
