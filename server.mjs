/* Локальный сервер лагеря. Запуск на ноутбуке организатора:
       node server.mjs            (порт 8000)
       node server.mjs 8080
       node server.mjs --selftest (проверка без запуска)

   Зачем он, если landing.html и так открывается двойным кликом:
     1. Раздаёт папку в лагерную Wi-Fi — телефоны ставят PWA и работают офлайн.
     2. В сеть отдаёт только лендинг, воркер, манифест и иконки — по белому
        списку. Персональные данные, админка, users.json с хэшами паролей
        и всё, что появится в папке потом, доступны только с самого
        ноутбука (127.0.0.1). Это и есть главная граница доверия: вход
        в админке — второй слой поверх неё, а не вместо неё.
     3. Версия кэша в sw.js считается из хэша landing.html. Сохранили правку
        в админке — у всех телефонов кэш обновится сам, без правки sw.js.
     4. Снимок participants.json в backups/ при каждом изменении: админка
        бэкапит один раз за сессию, а деньги перезаписываются каждые 2 сек.
     5. Принимает записи на мастер-классы с телефонов (POST /signup) и
        складывает их в signups.json. Это единственный путь записи в папку
        извне; сам файл наружу не отдаётся, его читает только админка.

   Админку открывать на этом же ноутбуке: http://localhost:8000/admin.html
   (File System Access API работает на localhost — она пишет landing.html
   прямо в эту папку, сервер сразу отдаёт новую версию).
   Участникам давать: http://<ip-ноутбука>:8000/landing.html

   На домене (camp.offline-tambov.ru) — тот же файл, но с CAMP_PUBLIC=1:
       CAMP_PUBLIC=1 node server.mjs 8000
   Тогда доверенных адресов нет вообще: наружу уходит только белый список,
   админка не открывается ни с какого адреса и остаётся на ноутбуке.
   Подробности и конфиги — в deploy/README.md.                              */

import http from 'node:http';
import fs   from 'node:fs';
import path from 'node:path';
import os   from 'node:os';
import { createHash } from 'node:crypto';

const ROOT = import.meta.dirname;
const PORT = Number(process.argv.find(a => /^\d+$/.test(a))) || 8000;

/* БЕЛЫЙ СПИСОК: в лагерную Wi-Fi уходит только то, что перечислено здесь.
   Всё остальное — 404, включая файл, который положат в папку завтра.
   Список полный: это ровно то, что просит landing.html со своего origin
   (сама страница, манифест, воркер и две иконки из icons/).

   Нужно раздать участникам что-то ещё — фото, карту, pdf с программой:
   сложите в папку и впишите её сюда в PUBLIC_DIRS одной строкой.
   С самого ноутбука (127.0.0.1) открывается всё — списки его не касаются. */
const PUBLIC_FILES = new Set(['landing.html', 'sw.js', 'manifest.webmanifest']);
const PUBLIC_DIRS  = new Set(['icons']);

function isPublic(relPath){
  const parts = relPath.split(path.sep);
  return parts.length === 1
    ? PUBLIC_FILES.has(parts[0])
    : PUBLIC_DIRS.has(parts[0]);          // внутри разрешённой папки — всё
}

const MIME = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8',
  '.json':'application/json; charset=utf-8', '.webmanifest':'application/manifest+json; charset=utf-8',
  '.css':'text/css; charset=utf-8', '.png':'image/png', '.jpg':'image/jpeg', '.svg':'image/svg+xml',
  '.ico':'image/x-icon', '.woff2':'font/woff2', '.txt':'text/plain; charset=utf-8' };

/* ── 1. Границы доверия ──────────────────────────────────────── */

/* Выход за пределы папки — единственная реальная дыра статик-сервера.
   Сравниваем уже разрешённый путь, а не строку из запроса. */
export function safePath(urlPath){
  let p;
  try { p = decodeURIComponent(new URL(urlPath, 'http://x').pathname); }
  catch { return null; }                                  // битый %-эскейп
  if (p.endsWith('/')) p += 'landing.html';
  const abs = path.resolve(ROOT, '.' + p);
  return abs === ROOT || abs.startsWith(ROOT + path.sep) ? abs : null;
}

export const isLocal = addr =>
  addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';

/* ПУБЛИЧНЫЙ РЕЖИМ: CAMP_PUBLIC=1 — сервер стоит за nginx на домене.

   На ноутбуке в лагере «пришло с 127.0.0.1» означает «это сам организатор»:
   больше на loopback никого нет, и isLocal() — честная граница доверия.
   За обратным прокси эти два факта расходятся. nginx стоит на той же
   машине, поэтому КАЖДЫЙ запрос из интернета приходит с 127.0.0.1 —
   и isLocal() отдал бы всему миру admin.html, users.json и участников.

   Поэтому в публичном режиме доверенных нет вообще: наружу уходит только
   белый список, а админка не открывается ни с какого адреса. Так и надо:
   она пишет файлы рядом с собой через File System Access API, на сервере
   ей нечего делать — она остаётся на ноутбуке организатора. */
const PUBLIC_ONLY = process.env.CAMP_PUBLIC === '1';

export const trusted = (addr, publicOnly = PUBLIC_ONLY) => !publicOnly && isLocal(addr);

/* За прокси все соединения приходят с 127.0.0.1, так что «кто это» для
   счётчика частоты берём из X-Real-IP, который ставит nginx. Заголовку
   верим ТОЛЬКО здесь: подделка X-Real-IP даёт злоумышленнику свежий лимит
   запросов и ничего больше — прав она не даёт, потому что прав в публичном
   режиме не выдаётся никому (см. trusted() выше). */
const whoIP = req => (PUBLIC_ONLY && String(req.headers['x-real-ip'] || '').trim())
                  || req.socket.remoteAddress || '';

/* Ограничитель частоты для POST /me и /signup. В лагерной Wi-Fi он был не
   нужен — там свои. На домене POST /me превращается в оракул «есть ли
   такой номер в лагере», и отвечает он именем и комнатой. Перебрать все
   10 цифр нереально, а проверить сотню знакомых номеров — минутное дело.
   30 запросов в минуту на адрес: человеку с телефоном хватает с запасом. */
const RATE = { max: 30, win: 60_000 };
const hits = new Map();
export function tooOften(ip, now = Date.now(), store = hits){
  if (store.size > 5000)
    for (const [k, v] of store) if (now > v.until) store.delete(k);
  const rec = store.get(ip);
  if (!rec || now > rec.until){ store.set(ip, { n:1, until: now + RATE.win }); return false; }
  return ++rec.n > RATE.max;
}

/* ── 2. Самоверсионирование кэша ──────────────────────────────── */

/* Версия = хэш содержимого лендинга. Меняется лендинг → меняются байты
   sw.js → браузер переустанавливает воркер и заново тянет оболочку. */
export function swBody(swText, landingText){
  const v = createHash('sha256').update(landingText).digest('hex').slice(0, 12);
  return swText.replace(/const CACHE\s*=\s*'[^']*';/, `const CACHE = 'offline-camp-${v}';`);
}

/* ── 3. Снимки участников ─────────────────────────────────────── */

/* Админка бэкапит участников один раз за сессию — а сумма оплат
   перезаписывается каждые две секунды. Храним 20 последних состояний. */
function watchPeople(){
  const src = path.join(ROOT, 'participants.json');
  if (!fs.existsSync(src)) return;
  const dir = path.join(ROOT, 'backups');
  let last = '', t;
  const snap = () => {
    try {
      const text = fs.readFileSync(src, 'utf8');
      if (text === last || !text.trim()) return;
      last = text;
      fs.mkdirSync(dir, { recursive: true });
      const stamp = new Date().toISOString().slice(0,19).replace(/[:T]/g,'-');
      fs.writeFileSync(path.join(dir, `participants-${stamp}.json`), text);
      const old = fs.readdirSync(dir).filter(n => n.startsWith('participants-')).sort();
      for (const n of old.slice(0, Math.max(0, old.length - 20)))
        fs.rmSync(path.join(dir, n), { force: true });
    } catch (err) { console.error('снимок участников не удался:', err.message); }
  };
  snap();
  fs.watch(src, () => { clearTimeout(t); t = setTimeout(snap, 2000); });
}

/* ── 3.5 Записи на мастер-классы ──────────────────────────────── */

/* Единственный способ что-то ЗАПИСАТЬ: POST /signup из лагерной Wi-Fi.
   Всё остальное дерево только читается.

   Телефон не сообщает, кто он: он присылает свой номер, а участника по
   номеру находит СЕРВЕР в participants.json. Поэтому имя в signups.json
   всегда из карточки участника, а список участников в сеть не уходит —
   телефон узнаёт только про себя. Незнакомый номер получает отказ.

   Здесь же живёт лимит мест: cap задаётся в админке, лежит в CAMP
   лендинга и проверяется до записи. Клиенту верить нельзя — он
   офлайновый и о чужих записях не знает.

   signups.json пишет только этот процесс: и лендинг, и бот идут через
   POST /signup. Поэтому сохранение участников из админки не может
   затереть запись, пришедшую с телефона секунду назад.

   Наружу файл не отдаётся: в PUBLIC_FILES его нет, значит
   GET /signups.json из Wi-Fi — 404. Это проверяется в selftest. */
const SIGN     = path.join(ROOT, 'signups.json');
const PEOPLE   = path.join(ROOT, 'participants.json');
const MAX_ROWS = 3000;                       // чтобы шалун не завалил диск
const LIM      = { id:40, name:60, cls:80, room:20 };
const JSONT    = 'application/json; charset=utf-8';

/* Пришло из сети: не доверяем ни типу, ни длине, ни содержимому. */
const clean = (v, n) => typeof v === 'string'
  ? v.replace(/[\u0000-\u001F\u007F]/g, ' ').trim().slice(0, n) : '';

/* Телефон сравниваем по последним 10 цифрам: +7, 8 и 7 — один и тот же
   номер, а записан он у всех по-своему. Короче 10 цифр — не номер. */
export const phoneKey = v => { const d = String(v ?? '').replace(/\D/g, '');
                               return d.length >= 10 ? d.slice(-10) : ''; };
/* Один и тот же человек не должен занять два места: и лендинг, и бот
   берут имя из карточки участника, поэтому имя — надёжный ключ «кто». */
const nameKey = v => String(v ?? '').trim().toLowerCase().replace(/\s+/g, ' ');

/* Кто записался: телефон с лендинга или id аккаунта из бота (bots.mjs
   ходит сюда же и присылает id — контракт для него не менялся). */
export function whoKey(rec){
  const ph = phoneKey(rec && rec.phone);
  if (ph) return 'p:' + ph;
  const id = clean(rec && rec.id, LIM.id);
  return /^[A-Za-z0-9_-]{6,40}$/.test(id) ? 'i:' + id : '';
}
const keyOf = r => r.who || (r.phone ? 'p:' + phoneKey(r.phone) : r.id ? 'i:' + r.id : '');

/* Ключ, под которым мастер-класс лежит в записях: тот же, что в лендинге
   (function clsKey) и в админке (ckey). Один класс в разные дни — разные
   группы с разными местами, поэтому день входит в ключ. */
const clsKey = c => c && c.day ? c.name + ' · ' + c.day : (c ? c.name : '');

/* Чистая функция: список + запись → новый список. Одна строка на пару
   (кто, мастер-класс), off:true её снимает. null — запись негодная.
   Лимит проверяется НЕ здесь: это дело сервера, у которого есть люди. */
export function applySignup(list, rec, at){
  if (!rec || typeof rec !== 'object') return null;
  const who = whoKey(rec), cls = clean(rec.cls, LIM.cls);
  if (!who || !cls) return null;
  const rest = list.filter(r => !(keyOf(r) === who && r.cls === cls));
  if (rec.off) return rest;                            // отмена — просто убрали
  const name = clean(rec.name, LIM.name);
  if (!name || rest.length >= MAX_ROWS) return null;
  return [...rest, { who, name, room: clean(rec.room, LIM.room), cls, at }];
}

/* Сколько мест занято. Записи с телефонов и то, что штаб вписал руками,
   считаются вместе и по имени — иначе один человек занял бы два места. */
export function takenOf(cls, list, people){
  const who = new Set();
  for (const p of people)
    if (p && p.status !== 'cancelled' && (p.classes || []).includes(cls))
      who.add(nameKey(p.name) || 'без имени ' + who.size);
  for (const r of list)
    if (r && r.cls === cls) who.add(nameKey(r.name) || 'без имени ' + who.size);
  return who.size;
}
/* Что показывать на карточках: занято/всего по каждой группе.
   cap пустой или 0 — «без ограничения», так это и понимает админка. */
export function seatsOf(classes, list, people){
  const out = {};
  for (const c of classes || [])
    out[clsKey(c)] = { taken: takenOf(clsKey(c), list, people), cap: Number(c.cap) || 0 };
  return out;
}
export const isFull = seat => !!seat && seat.cap > 0 && seat.taken >= seat.cap;

function readJson(file){
  try {
    const a = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(a) ? a : [];
  } catch { return [] }                    // файла нет или он битый — начинаем с нуля
}
const readSignups = () => readJson(SIGN);
const readPeople  = () => readJson(PEOPLE);

/* через .tmp + rename: админка не должна прочитать файл на середине записи */
function writeSignups(list){
  fs.writeFileSync(SIGN + '.tmp', JSON.stringify(list, null, 2));
  fs.renameSync(SIGN + '.tmp', SIGN);
}

/* Мастер-классы и лимиты живут в лендинге — там их правит админка.
   Разбираем тем же приёмом, что и админка, и держим до правки файла. */
let campCache = { mt:0, classes:[] };
export function campClasses(){
  const f = path.join(ROOT, 'landing.html');
  try {
    const mt = fs.statSync(f).mtimeMs;
    if (mt !== campCache.mt){
      const m = fs.readFileSync(f, 'utf8').match(/const CAMP\s*=\s*\{[\s\S]*?\n\};/);
      const camp = new Function('return (' + m[0].slice(m[0].indexOf('{'), -1) + ')')();
      campCache = { mt, classes: Array.isArray(camp.classes) ? camp.classes : [] };
    }
  } catch (err) { /* лендинг правят прямо сейчас — живём на прошлом разборе */ }
  return campCache.classes;
}

/* Что телефон знает о себе: имя, свои записи и записи, которые сделал
   штаб (их снимать нельзя — это не его запись), плюс занятость групп. */
function meAnswer(person, list, people){
  const who  = 'p:' + phoneKey(person.phone);
  const mine = list.filter(r => keyOf(r) === who).map(r => r.cls);
  const org  = (person.classes || []).filter(c => !mine.includes(c));
  return { ok:true, name: person.name || '', room: person.room || '',
           mine, locked: org, seats: seatsOf(campClasses(), list, people) };
}

function body(req, res, send, done){
  let text = '';
  req.on('data', c => {
    text += c;
    if (text.length > 2048) { send(413, 'Слишком большая запись'); req.destroy(); }
  });
  req.on('end', () => {
    if (res.writableEnded) return;
    try { done(JSON.parse(text)); }
    catch { send(400, JSON.stringify({ ok:false, error:'bad' }), JSONT) }
  });
}

/* POST /me {phone} — «кто я и куда записан» */
function me(req, res, send){
  body(req, res, send, rec => {
    const people = readPeople();
    const ph = phoneKey(rec && rec.phone);
    const person = ph && people.find(p => phoneKey(p.phone) === ph);
    if (!person) return send(404, JSON.stringify({ ok:false, error:'not_found' }), JSONT);
    send(200, JSON.stringify(meAnswer(person, readSignups(), people)), JSONT);
  });
}

/* POST /signup {phone, cls, off} — запись и отмена */
function signup(req, res, send){
  body(req, res, send, rec => {
    const people = readPeople();
    const list   = readSignups();
    const cls    = clean(rec && rec.cls, LIM.cls);
    const ph     = phoneKey(rec && rec.phone);

    /* с лендинга приходит только номер: имя и комнату ставим из карточки,
       чтобы в записи не оказалось того, что человек напечатал сам */
    let person = null;
    if (ph){
      person = people.find(p => phoneKey(p.phone) === ph);
      if (!person) return send(404, JSON.stringify({ ok:false, error:'not_found' }), JSONT);
      rec = { ...rec, name: person.name, room: person.room };
    }

    const seat = seatsOf(campClasses(), list, people)[cls];
    const mine = list.some(r => keyOf(r) === whoKey(rec) && r.cls === cls)
              || (person && (person.classes || []).includes(cls));
    /* уже записанного лимит не касается: он одно из занятых мест */
    if (!rec.off && !mine && isFull(seat))
      return send(409, JSON.stringify({ ok:false, error:'full', ...seat }), JSONT);

    const next = applySignup(list, rec, new Date().toISOString().slice(0,16).replace('T',' '));
    if (!next) return send(400, JSON.stringify({ ok:false, error:'bad' }), JSONT);
    try { writeSignups(next); }
    catch (err) { return send(500, JSON.stringify({ ok:false, error:err.message }), JSONT) }

    send(200, JSON.stringify(person
      ? meAnswer(person, next, people)
      : { ok:true, count:next.length }), JSONT);        // бот смотрит только на код ответа
  });
}

/* GET /seats — занятость групп: числа, без имён. Нужна всем, кто открыл
   страницу, ещё до всякого телефона. */
function seats(send){
  send(200, JSON.stringify(seatsOf(campClasses(), readSignups(), readPeople())), JSONT);
}

/* ── 4. Сервер ────────────────────────────────────────────────── */

function serve(req, res){
  const local = trusted(req.socket.remoteAddress);
  const send = (code, body, type='text/plain; charset=utf-8') =>
    res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-cache' }).end(body);

  const route = req.url.split('?')[0];
  if (req.method === 'POST' && (route === '/signup' || route === '/me')){
    if (!local && tooOften(whoIP(req)))
      return send(429, JSON.stringify({ ok:false, error:'too_often' }), JSONT);
    return route === '/signup' ? signup(req, res, send) : me(req, res, send);
  }
  if (req.method === 'GET'  && route === '/seats')  return seats(send);
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(405, 'Только GET');

  const abs = safePath(req.url);
  if (!abs) return send(403, 'Нельзя выходить за пределы папки');

  const name = path.basename(abs);
  const rel  = path.relative(ROOT, abs);
  if (!local && !isPublic(rel))
    return send(404, 'Не найдено');            // 404, а не 403: не подсказываем, что файл есть

  let stat;
  try { stat = fs.statSync(abs); } catch { return send(404, 'Не найдено') }
  if (stat.isDirectory()) return send(404, 'Не найдено');

  const type = MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream';

  if (name === 'sw.js') {
    try {
      const body = swBody(fs.readFileSync(abs,'utf8'),
                          fs.readFileSync(path.join(ROOT,'landing.html'),'utf8'));
      return send(200, body, type);
    } catch (err) { return send(500, 'sw.js: ' + err.message) }
  }

  res.writeHead(200, { 'Content-Type': type, 'Content-Length': stat.size,
                       'Cache-Control': 'no-cache' });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(abs).pipe(res).on('error', () => res.destroy());
}

/* ── 5. Проверка ──────────────────────────────────────────────── */

function selftest(){
  const a = (ok, what) => { console.log((ok ? '  ok   ' : '  ПЛОХО') + '  ' + what);
                            if (!ok) process.exitCode = 1; };
  /* инвариант: наружу папки путь не выходит НИКОГДА — либо null, либо внутри.
     new URL сам схлопывает ../ выше корня, но на %2e%2e он этого не делает,
     поэтому проверка startsWith в safePath обязательна. */
  const inside = u => { const r = safePath(u);
                        return r === null || r === ROOT || r.startsWith(ROOT + path.sep); };
  a(['/../../etc/passwd','/icons/../../../etc/passwd','/%2e%2e%2fetc','/%2e%2e/%2e%2e/etc',
     '/..%2f..%2fetc','/./../../etc','//etc/passwd','/a/b/../../../../etc','/%00','/%zz']
     .every(inside),                                    'наружу папки не выходим ни на одном пути');
  a(safePath('/%2e%2e%2fetc') === null,                 'закодированный ../ отбит');
  a(safePath('/') === path.join(ROOT,'landing.html'),  '/ → landing.html');
  a(safePath('/landing.html').startsWith(ROOT),        'обычный путь внутри папки');
  a(isLocal('::ffff:127.0.0.1') && isLocal('::1'),     'loopback распознан');
  a(!isLocal('192.168.1.5'),                           'адрес из Wi-Fi не loopback');

  /* Главный инвариант деплоя: за nginx весь интернет приходит с 127.0.0.1,
     и привилегий этот адрес там давать не должен. */
  a(trusted('127.0.0.1', false) && trusted('::1', false), 'на ноутбуке loopback — это организатор');
  a(!trusted('127.0.0.1', true) && !trusted('::1', true), 'на домене loopback привилегий не даёт');
  a(['192.168.1.5','10.0.0.7','203.0.113.9']
      .every(ip => !trusted(ip, false) && !trusted(ip, true)),
                                                        'чужой адрес не привилегирован никогда');

  /* Лимит частоты: 30 в минуту, 31-й отбит, через минуту счёт с нуля. */
  const box = new Map(), t0 = 1_000_000;
  a(Array.from({ length:30 }, () => tooOften('ip', t0, box)).every(v => v === false),
                                                        '30 запросов в минуту проходят');
  a(tooOften('ip', t0, box),                            '31-й запрос отбит');
  a(!tooOften('ip', t0 + 60_001, box),                  'через минуту счёт с нуля');
  a(!tooOften('другой', t0 + 60_001, box),              'лимит считается по каждому адресу свой');
  const sw = "const CACHE = 'offline-camp-v1';\nconst SHELL=[];";
  const v1 = swBody(sw, 'landing A'), v2 = swBody(sw, 'landing B');
  a(v1 !== v2,                                         'версия кэша меняется вместе с лендингом');
  a(v1 === swBody(sw, 'landing A'),                    'та же страница — та же версия');
  a(/const CACHE = 'offline-camp-[0-9a-f]{12}';/.test(v1), 'CACHE подставлен корректно');
  a(v1.includes('const SHELL=[]'),                     'остальной sw.js не тронут');
  const P = p => isPublic(p.split('/').join(path.sep));
  a(['landing.html','sw.js','manifest.webmanifest','icons/icon-192.png',
     'icons/apple-touch-icon.png'].every(P),           'всё нужное лендингу раздаётся');
  a(['participants.json','users.json','admin.html','reception.html','server.mjs','landing.backup.html',
     'landing.v1-selling.html','смета.xlsx','.DS_Store','backups/participants-1.json',
     'backups/users-1.json','landing.html.bak','sw.js.map'].every(x => !P(x)),
                                                        'посторонний файл в сеть не уходит');
  a(!P('users.json'),                                   'хэши паролей в лагерную Wi-Fi не уходят');
  a(!P('участники.json'),                              'новый файл закрыт по умолчанию');
  /* стык двух проверок: белый список смотрит на РАЗРЕШЁННЫЙ путь, поэтому
     ../ из разрешённой папки не открывает доступ к соседнему файлу */
  a(!P('signups.json') && !P('signups.json.tmp'),      'записи на МК наружу не отдаются');

  /* телефон — это и есть «кто»: участника по номеру находит сервер */
  a(['+7 (900) 111-22-33', '8 900 111 22 33', '79001112233', ' 9001112233 ']
      .every(v => phoneKey(v) === '9001112233'),         'номер узнаётся в любом написании');
  a(['12345', '', null, undefined, {}].every(v => phoneKey(v) === ''),
                                                        'огрызок вместо номера отброшен');
  a(whoKey({ phone:'+79001112233' }) === 'p:9001112233', 'с лендинга ключ записи — телефон');
  a(whoKey({ id:'ab12cd34' }) === 'i:ab12cd34',          'из бота ключ записи — его id');
  a(whoKey({ phone:'нет номера', id:'ab12cd34' }) === 'i:ab12cd34',
                                                        'без номера остаётся id бота');
  a(whoKey({}) === '' && whoKey(null) === '',            'записи без «кто» не бывает');

  /* лимит мест: считаем людей, а не строки */
  const ppl = [{ name:'Аня',   phone:'+7 900 111-22-33', classes:['Музыка · СР'] },
               { name:'Боря',  phone:'',                 classes:['Музыка · СР'] },
               { name:'Отказ', phone:'+7 900 999-99-99', classes:['Музыка · СР'], status:'cancelled' }];
  const sg  = [{ who:'p:9001112233', name:'Аня',  cls:'Музыка · СР' },   // Аня уже посчитана
               { who:'i:tg777777',   name:'Женя', cls:'Музыка · СР' }];
  a(takenOf('Музыка · СР', sg, ppl) === 3,               'один человек не занимает два места');
  a(takenOf('Музыка · СР', [], []) === 0,                'в пустой группе никого');
  a(takenOf('Музыка · СР', sg, ppl.map(p => ({ ...p, status:'cancelled' }))) === 2,
                                                        'отказавшийся место не держит');
  const st = seatsOf([{ name:'Музыка', day:'СР', cap:3 }, { name:'Музыка', day:'ЧТ', cap:3 },
                      { name:'Спорт', cap:'' }], sg, ppl);
  a(st['Музыка · СР'].taken === 3 && st['Музыка · ЧТ'].taken === 0,
                                                        'один класс в разные дни — разные места');
  a(isFull(st['Музыка · СР']) && !isFull(st['Музыка · ЧТ']),  'заполненная группа закрыта');
  a(!isFull(st['Спорт']) && !isFull(undefined),          'пустой cap и незнакомая группа не ограничивают');
  a(campClasses().length > 0 && campClasses().every(c => typeof c.name === 'string'),
                                                        'мастер-классы читаются из самого лендинга');

  /* записи на мастер-классы: телефон шлёт (id, мастер-класс), сервер сводит */
  const s1 = applySignup([], { id:'ab12cd34', name:'Аня', cls:'Музыка' }, '2026-08-26 14:00');
  a(s1.length === 1 && s1[0].name === 'Аня' && s1[0].at === '2026-08-26 14:00',
                                                       'запись на мастер-класс принята');
  a(applySignup(s1, { id:'ab12cd34', name:'Аня', cls:'Музыка' }, 'x').length === 1,
                                                       'повторное нажатие не двоит запись');
  a(applySignup(s1, { id:'ab12cd34', name:'Аня Петрова', cls:'Музыка' }, 'x')[0].name === 'Аня Петрова',
                                                       'уточнённое имя заменяет прежнее');
  a(applySignup(s1, { id:'ab12cd34', cls:'Музыка', off:true }, 'x').length === 0,
                                                       'отмена снимает запись');
  a(applySignup(s1, { id:'ab12cd34', name:'Аня', cls:'Спорт' }, 'x').length === 2,
                                                       'второй мастер-класс — вторая запись');
  a(applySignup(s1, { id:'zz99zz99', name:'Боря', cls:'Музыка' }, 'x').length === 2,
                                                       'другой телефон не затирает чужую запись');
  a([null, 'строка', {}, { id:'ab12cd34' }, { id:'коротк', name:'А', cls:'Музыка' },
     { id:'ab12cd34', name:'', cls:'Музыка' }, { id:'ab12cd34', name:'Аня', cls:'' },
     { id:'../../etc', name:'Аня', cls:'Музыка' }]
     .every(r => applySignup([], r, 'x') === null),     'мусор из сети в файл не попадает');
  const long = applySignup([], { id:'ab12cd34', name:'А'.repeat(300), cls:'М'.repeat(300),
                                 room:'к'.repeat(99) }, 'x')[0];
  a(long.name.length === 60 && long.cls.length === 80 && long.room.length === 20,
                                                       'слишком длинные поля урезаны');
  a(!/[\u0000-\u001F]/.test(applySignup([], { id:'ab12cd34', name:'А\u0000н\tю', cls:'Музыка' }, 'x')[0].name),
                                                       'управляющие символы вычищены');
  a(applySignup(Array.from({ length:3000 }, (_,i) => ({ id:'id'+i, cls:'c', name:'n' })),
                { id:'ab12cd34', name:'Аня', cls:'Музыка' }, 'x') === null,
                                                       'переполнение файла записями отбито');
  a(['/icons/../participants.json','/icons/%2e%2e/users.json','/icons/./../admin.html']
      .every(u => { const abs = safePath(u);
                    return abs === null || !isPublic(path.relative(ROOT, abs)); }),
                                                       'через ../ из icons/ не выйти');
}

if (process.argv.includes('--selftest')) { selftest(); }
else {
  watchPeople();
  http.createServer(serve).listen(PORT, '0.0.0.0', () => {
    const ip = Object.values(os.networkInterfaces()).flat()
      .find(i => i && i.family === 'IPv4' && !i.internal)?.address || 'localhost';
    if (PUBLIC_ONLY) {
      console.log(`\n  ПУБЛИЧНЫЙ РЕЖИМ: доверенных адресов нет, админка закрыта.`);
      console.log(`  Слушаю ${PORT} — nginx должен проксировать сюда.`);
    } else {
      console.log(`\n  Штаб:      http://localhost:${PORT}/admin.html`);
      console.log(`  Участникам: http://${ip}:${PORT}/landing.html`);
    }
    console.log(`  В сеть отдаются только: ${[...PUBLIC_FILES].join(', ')}, ` +
                `${[...PUBLIC_DIRS].map(d => d + '/*').join(', ')}`);
    console.log(`  Записи на мастер-классы принимаются в signups.json ` +
                `(${readSignups().length} шт.) — смотреть в админке\n`);
  });
}
