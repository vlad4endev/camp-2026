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
     6. Отдаёт блок CAMP из лендинга на GET /camp. Открытая на телефоне
        страница спрашивает его раз в 30 секунд и пересобирается на месте:
        штаб сохранил правку — она у всех, без перезагрузки. Ничего нового
        наружу это не открывает, тот же блок лежит в самом landing.html.

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
/* Единая база. Без SUPABASE_URL модуль выключен и всё работает на файлах,
   как раньше: переезд включается по одной машине. Подробности в db.mjs. */
import * as db from './db.mjs';

/* import.meta.dirname появился в Node 20.11. На Debian 12 и Ubuntu 24.04
   `apt install nodejs` ставит 18.x — там ROOT молча станет undefined, и
   сервер упадёт внутри path.resolve с невнятным TypeError. Говорим прямо. */
if (!import.meta.dirname) {
  console.error(`Нужен Node 20.11 или новее — установлен ${process.version}.`);
  console.error('Как поставить свежий: deploy/README.md, раздел «Первая установка».');
  process.exit(1);
}

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
/* Снимки в backups/: 20 последних состояний каждого файла.

   Теперь это единственная история правок, которая есть у лендинга: его
   правит панель на сервере, а не git. Поэтому снимаем и его, а не только
   участников — иначе «откатить объявление» было бы неоткуда.

   users.json и integrations.json не снимаем намеренно: множить копии
   хэшей и токенов по папке — плохая идея, а терять там нечего, эти файлы
   не наполняются day-to-day. */
const SNAP = new Set(['participants.json', 'landing.html']);
const lastSnap = {};

export function snapFile(name){
  if (!SNAP.has(name)) return;
  const src  = path.join(ROOT, name);
  const dir  = path.join(ROOT, 'backups');
  const stem = name.replace(/\.[^.]+$/, '');
  const ext  = path.extname(name);
  try {
    const text = fs.readFileSync(src, 'utf8');
    if (text === lastSnap[name] || !text.trim()) return;
    lastSnap[name] = text;
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().slice(0,19).replace(/[:T]/g,'-');
    fs.writeFileSync(path.join(dir, `${stem}-${stamp}${ext}`), text);
    const old = fs.readdirSync(dir).filter(n => n.startsWith(stem + '-')).sort();
    for (const n of old.slice(0, Math.max(0, old.length - 20)))
      fs.rmSync(path.join(dir, n), { force: true });
  } catch (err) { console.error(`снимок ${name} не удался:`, err.message); }
}
export const snapPeople = () => snapFile('participants.json');

/* fs.watch ловит правки извне — rsync с ноутбука. Записи из панели он бы
   пропустил: PUT кладёт файл через .tmp + rename, а rename подменяет inode
   и слежение за путём срывается. Поэтому PUT зовёт snapPeople() сам. */
function watchPeople(){
  const src = path.join(ROOT, 'participants.json');
  if (!fs.existsSync(src)) return;
  let t;
  snapPeople();
  fs.watch(src, () => { clearTimeout(t); t = setTimeout(snapPeople, 2000); });
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
let campCache = { mt:0, v:'', camp:null };
export function campData(){
  /* С единой базой содержимое лагеря приходит из camp.json — зеркала,
     которое db.mjs обновляет из Supabase. Версию считает база, поэтому
     свою здесь не пересчитываем. Зеркала ещё нет (первый запуск, пустая
     база) — разбираем лендинг, как раньше: пусто лучше не отдавать. */
  if (db.configured()){
    const m = db.camp();
    if (m && m.camp) return m;
  }
  const f = path.join(ROOT, 'landing.html');
  try {
    const mt = fs.statSync(f).mtimeMs;
    if (mt !== campCache.mt){
      const m = fs.readFileSync(f, 'utf8').match(/const CAMP\s*=\s*\{[\s\S]*?\n\};/);
      const src = m[0].slice(m[0].indexOf('{'), -1);
      /* Версия — хэш самого литерала, а не файла: правка вёрстки не должна
         заставлять полсотни телефонов перерисовываться на ровном месте. */
      campCache = { mt, v: createHash('sha256').update(src).digest('hex').slice(0, 12),
                    camp: new Function('return (' + src + ')')() };
    }
  } catch (err) { /* лендинг правят прямо сейчас — живём на прошлом разборе */ }
  return campCache;
}
export function campClasses(){
  const c = campData().camp;
  return Array.isArray(c && c.classes) ? c.classes : [];
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

    /* ── путь через единую базу ──
       Лимит здесь больше не решающий: его проверяет claim_seat внутри
       транзакции, поэтому на 12 мест не может прийти 13 человек, даже
       если два телефона нажали одновременно. Проверка выше остаётся как
       быстрый отказ без похода в сеть. */
    if (db.configured()){
      const who = whoKey(rec);
      if (!who || !cls) return send(400, JSON.stringify({ ok:false, error:'bad' }), JSONT);
      return db.signup({ who, name: clean(rec.name, LIM.name),
                         room: clean(rec.room, LIM.room), cls, off: !!rec.off })
        .then(r => {
          if (r && r.error === 'full')
            return send(409, JSON.stringify(r), JSONT);
          if (!r || !r.ok)
            return send(400, JSON.stringify(r || { ok:false, error:'bad' }), JSONT);
          /* зеркало db.signup уже обновил — перечитываем и отвечаем тем
             же, чем отвечали всегда: телефон не знает про переезд */
          const fresh = readSignups(), ppl = readPeople();
          send(200, JSON.stringify(person
            ? { ...meAnswer(ppl.find(p => p.id === person.id) || person, fresh, ppl),
                queued: !!r.queued }
            : { ok:true, count: fresh.length, queued: !!r.queued }), JSONT);
        })
        .catch(err => send(500, JSON.stringify({ ok:false, error:err.message }), JSONT));
    }

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

/* GET /camp[?v=…] — данные лендинга целиком: расписание, объявления,
   тематика дня, мастер-классы, тексты. Штаб сохранил landing.html —
   открытые телефоны заберут отсюда новую версию и пересоберут страницу,
   не перезагружаясь. Совпал v — отвечаем «то же самое», без пересылки:
   раз в 30 секунд с каждого телефона качать десятки килобайт незачем. */
function camp(send, was){
  const c = campData();
  send(200, JSON.stringify(was === c.v && c.v
    ? { v:c.v, same:true }
    : { v:c.v, camp:c.camp }), JSONT);
}

/* ── 3.7 Запись из панели (PUT) ────────────────────────────────

   Панели правят файлы у себя же на сервере. Доступно ТОЛЬКО на порту
   панели (PORT+1, слушает loopback): в публичный порт PUT не приходит
   никогда, там метод не разрешён вообще.

   Разрешённые имена перечислены списком. Это не паранойя: safePath не
   пускает за пределы папки, но и внутри писать можно далеко не всё —
   server.mjs, sw.js и bots.mjs правит только человек через git.

   JSON проверяем разбором до записи: битый participants.json хуже
   отсутствующего — сервер сочтёт его пустым и начнёт отвечать «нет
   такого номера» всем участникам сразу. */
const WRITABLE = new Set(['landing.html', 'participants.json',
                          'users.json', 'integrations.json']);

/* СТОЙКА — отдельный пропуск с отдельным паролем. Раздельные пароли сами
   по себе были бы косметикой: с паролем стойки можно было бы открыть
   /reseption/admin.html и получить весь штаб, потому что порт панели
   отдаёт всё. Поэтому у стойки свой порт и свой короткий список.

   Ресепшен правит только участников — значит остального для него не
   существует: ни admin.html, ни лендинга, ни integrations.json с токенами
   ботов. Пароль у стойки — это пароль человека, который принимает деньги,
   а не человека, который правит расписание.

   users.json стойке нужен: вход в ресепшен идёт по нему же. Отфильтровать
   его не выйдет — роль admin входит и на стойке, так что её хэш там нужен
   по делу. Разделение здесь не про сокрытие хэшей, а про то, что стойка
   physically не может ни открыть штаб, ни перезаписать лендинг. */
const DESK_READ  = new Set(['reception.html', 'camp-db.js',
                            'participants.json', 'users.json']);
const DESK_WRITE = new Set(['participants.json']);

export const canWrite = (name, role = 'panel') =>
  (role === 'desk' ? DESK_WRITE : WRITABLE).has(name);
export const canRead  = (role, rel) => role !== 'desk' || DESK_READ.has(rel);
const MAX_PUT  = 4 * 1024 * 1024;              // лендинг ~310 КБ, запас большой

function put(req, res, send, role = 'panel'){
  /* Имя берём из маршрута целиком, а не basename: тот срезал бы путь и
     принял PUT /../landing.html как landing.html. Наружу папки это всё
     равно не выводит (join с ROOT), но поведение должно совпадать с
     canWrite() из проверок, а не «случайно быть безопасным». */
  const name = req.url.split('?')[0].replace(/^\//, '');
  if (!canWrite(name, role))
    return send(403, JSON.stringify({ ok:false, error:'not_writable', name }), JSONT);

  let text = '', over = false;
  req.on('data', c => {
    text += c;
    if (text.length > MAX_PUT && !over){
      over = true;
      send(413, JSON.stringify({ ok:false, error:'too_big' }), JSONT);
      req.destroy();
    }
  });
  req.on('end', () => {
    if (res.writableEnded) return;
    if (!text.trim())
      return send(400, JSON.stringify({ ok:false, error:'empty' }), JSONT);
    if (name.endsWith('.json')){
      try { JSON.parse(text); }
      catch { return send(400, JSON.stringify({ ok:false, error:'bad_json' }), JSONT) }
    }
    const abs = path.join(ROOT, name);
    try {
      fs.writeFileSync(abs + '.tmp', text);     // .tmp + rename: панель не должна
      fs.renameSync(abs + '.tmp', abs);         // прочитать файл на середине записи
    } catch (err) {
      return send(500, JSON.stringify({ ok:false, error:err.message }), JSONT);
    }
    snapFile(name);                            // участники и лендинг — в backups/
    send(200, JSON.stringify({ ok:true, bytes: Buffer.byteLength(text) }), JSONT);
  });
}

/* ── 3.8 Запись из панели в базу (POST /queue) ─────────────────

   Штаб и стойка ходят в Supabase напрямую — оттуда они работают с любого
   устройства. Но в лагере интернета нет, а заезд и деньги ждать не могут.
   Тогда панель стучится сюда, на локальный сервер: он либо дотянется до
   базы сам, либо положит операцию в очередь и дошлёт её, когда связь
   вернётся. Ответ в обоих случаях «принято» — queued:true говорит, что
   это ещё не в базе.

   Почему не PUT participants.json, который уже есть: этот файл теперь
   зеркало базы, и следующий же pull() затёр бы правку. Через очередь
   правка доезжает до источника правды.

   ТОЛЬКО порт панели: у публичного порта этого маршрута нет вовсе. */
function queue(req, res, send){
  if (!db.configured())
    return send(503, JSON.stringify({ ok:false, error:'no_db' }), JSONT);

  body(req, res, send, rec => {
    const op = rec && rec.op;
    const id = clean(rec && rec.id, LIM.id);
    let task;

    if (op === 'person'){
      if (!id || !rec.fields || typeof rec.fields !== 'object')
        return send(400, JSON.stringify({ ok:false, error:'bad' }), JSONT);
      task = db.savePerson(id, rec.fields);
    } else if (op === 'payment'){
      const sum = Number(rec.sum);
      if (!id || !Number.isFinite(sum) || sum === 0)
        return send(400, JSON.stringify({ ok:false, error:'bad' }), JSONT);
      task = db.addPayment(id, { id: rec.pay_id, at: clean(rec.at, 20),
                                 sum, note: clean(rec.note, 200) });
    } else if (op === 'payment_del'){
      if (!id || !rec.pay_id)
        return send(400, JSON.stringify({ ok:false, error:'bad' }), JSONT);
      task = db.delPayment(id, String(rec.pay_id));
    } else {
      return send(400, JSON.stringify({ ok:false, error:'unknown_op' }), JSONT);
    }

    task.then(r => send(200, JSON.stringify(r), JSONT))
        .catch(err => send(500, JSON.stringify({ ok:false, error:err.message }), JSONT));
  });
}

/* ── 4. Сервер ────────────────────────────────────────────────── */

/* role: 'public' — порт из интернета, 'panel' — штаб, 'desk' — стойка.
   Каждая роль это свой порт, и все непубличные слушают только loopback.
   Снаружи на них ведёт единственная дорога — location /admin/ и
   /reseption/ в nginx, каждая под своим паролем. Поэтому «пришло на этот
   порт» = «этот гейт пройден».

   Роль определяется портом, а не заголовком, намеренно: порт из интернета
   подделать нельзя, заголовок — можно, а цена ошибки здесь вся админка. */
function serve(req, res, role = 'public'){
  const local = role !== 'public' || trusted(req.socket.remoteAddress);
  const send = (code, body, type='text/plain; charset=utf-8') =>
    res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-cache' }).end(body);

  const route = req.url.split('?')[0];
  if (req.method === 'POST' && (route === '/signup' || route === '/me')){
    if (!local && tooOften(whoIP(req)))
      return send(429, JSON.stringify({ ok:false, error:'too_often' }), JSONT);
    return route === '/signup' ? signup(req, res, send) : me(req, res, send);
  }
  /* Очередь и её состояние — только с порта панели: участникам тут делать
     нечего, а в публичном порту этих маршрутов просто нет. */
  if (route === '/queue'){
    if (!local) return send(404, 'Не найдено');
    if (req.method !== 'POST') return send(405, 'Только POST');
    return queue(req, res, send);
  }
  if (req.method === 'GET' && route === '/dbstatus'){
    if (!local) return send(404, 'Не найдено');
    return send(200, JSON.stringify(db.status()), JSONT);
  }
  if (req.method === 'GET'  && route === '/seats')  return seats(send);
  if (req.method === 'GET'  && route === '/camp')
    return camp(send, new URL(req.url, 'http://x').searchParams.get('v'));
  if (req.method === 'PUT'){
    if (!local) return send(405, 'Только GET');   // публичный порт не пишет никогда
    return put(req, res, send, role);
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(405, 'Только GET');

  const abs = safePath(req.url);
  if (!abs) return send(403, 'Нельзя выходить за пределы папки');

  const name = path.basename(abs);
  const rel  = path.relative(ROOT, abs);
  if (!local && !isPublic(rel))
    return send(404, 'Не найдено');            // 404, а не 403: не подсказываем, что файл есть
  if (!canRead(role, rel))
    return send(404, 'Не найдено');            // стойке штаб не виден вообще

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

  /* X-Mtime в миллисекундах: панель сравнивает его с временем, которое
     запомнила при чтении, и не затирает файл, изменившийся тем временем.
     Last-Modified не годится — у него разрешение в секунду. */
  res.writeHead(200, { 'Content-Type': type, 'Content-Length': stat.size,
                       'X-Mtime': String(Math.round(stat.mtimeMs)),
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

  /* /camp — то, чем живёт синхронность: телефон должен получить весь блок
     данных и версию, по которой поймёт, что штаб что-то поменял. */
  const cd = campData();
  a(cd.camp && Array.isArray(cd.camp.days) && cd.camp.days.length > 0,
                                                       'из лендинга разобран весь CAMP, а не только мастер-классы');
  a(/^[0-9a-f]{12}$/.test(cd.v),                       'у данных лендинга есть версия');
  a(campData().v === cd.v && campData().camp === cd.camp,
                                                       'файл не менялся — версия и разбор те же');
  a(campClasses() === cd.camp.classes,                 'мастер-классы берутся из того же разбора');
  const P = p => isPublic(p.split('/').join(path.sep));
  a(['landing.html','sw.js','manifest.webmanifest','icons/icon-192.png',
     'icons/apple-touch-icon.png'].every(P),           'всё нужное лендингу раздаётся');
  a(['participants.json','users.json','admin.html','reception.html','server.mjs','landing.backup.html',
     'landing.v1-selling.html','смета.xlsx','.DS_Store','backups/participants-1.json',
     'backups/users-1.json','landing.html.bak','sw.js.map'].every(x => !P(x)),
                                                        'посторонний файл в сеть не уходит');
  a(!P('users.json'),                                   'хэши паролей в лагерную Wi-Fi не уходят');
  a(!P('integrations.json'),                            'токены ботов в лагерную Wi-Fi не уходят');
  a(!P('участники.json'),                              'новый файл закрыт по умолчанию');
  /* стык двух проверок: белый список смотрит на РАЗРЕШЁННЫЙ путь, поэтому
     ../ из разрешённой папки не открывает доступ к соседнему файлу */
  a(!P('signups.json') && !P('signups.json.tmp'),      'записи на МК наружу не отдаются');
  a(!P('integrations.json'),                            'токены ботов наружу не отдаются');
  /* Зеркало базы и очередь неотправленного — такие же приватные файлы,
     как participants.json: в них лежат имена, комнаты и деньги. */
  a(!P('camp.json') && !P('outbox.json') && !P('outbox.json.tmp'),
                                                        'зеркало базы и очередь наружу не отдаются');
  a(!canWrite('camp.json') && !canWrite('outbox.json'),  'зеркало базы панель через PUT не правит');

  /* Что панель имеет право перезаписать. Код и воркер — только через git:
     PUT туда означал бы удалённое исполнение кода на сервере. */
  a(['landing.html','participants.json','users.json','integrations.json'].every(canWrite),
                                                        'панель пишет свои четыре файла');
  a(['server.mjs','bots.mjs','sw.js','manifest.webmanifest','signups.json',
     'landing.backup.html','.gitignore','../landing.html','icons/icon-192.png',
     'landing.html.tmp','participants.json.tmp'].every(n => !canWrite(n)),
                                                        'ничего другого панель перезаписать не может');
  a(!canWrite('') && !canWrite('..') && !canWrite('.'),  'пустое имя и точки не проходят');

  /* Стойка и штаб разделены не паролем, а тем, что за паролем видно.
     Иначе с паролем стойки открывался бы /reseption/admin.html. */
  a(['reception.html','camp-db.js','participants.json','users.json']
      .every(n => canRead('desk', n)),                  'стойке видно то, что ей нужно');
  a(['admin.html','landing.html','integrations.json','signups.json','server.mjs',
     'sw.js','backups/participants-1.json'].every(n => !canRead('desk', n)),
                                                        'стойке штаб и лендинг не видны');
  a(['admin.html','landing.html','integrations.json'].every(n => canRead('panel', n)),
                                                        'штабу видно всё своё');
  a(canWrite('participants.json','desk'),               'стойка правит участников');
  a(['landing.html','users.json','integrations.json'].every(n => !canWrite(n,'desk')),
                                                        'стойка не правит ни лендинг, ни учётки, ни токены');
  a(canWrite('landing.html','panel') && canWrite('landing.html'),
                                                        'штаб правит лендинг, роль по умолчанию — штаб');

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
  /* Тянем зеркало из базы и досылаем очередь. Без SUPABASE_URL функция
     сразу возвращается — тогда сервер живёт на файлах, как раньше. */
  db.start({ every: Number(process.env.CAMP_SYNC_MS) || 15000,
             log: m => console.log('  база:', m) });
  /* В публичном режиме слушаем только loopback: единственный вход снаружи
     должен быть через nginx, иначе порт 8000 торчал бы в интернет в обход
     его лимитов и deny-локаций. В юните есть IPAddressDeny=any, но он
     зависит от BPF в cgroup — а эта строка не зависит ни от чего. */
  /* Порт панели поднимаем только в публичном режиме и только на loopback.
     Это и есть пропуск: снаружи сюда ведёт единственная дорога — location
     /admin/ и /reseption/ в nginx под Basic auth. На ноутбуке он не нужен,
     там панели открываются с 127.0.0.1 обычным порядком. */
  if (PUBLIC_ONLY){
    http.createServer((req, res) => serve(req, res, 'panel')).listen(PORT + 1, '127.0.0.1');
    http.createServer((req, res) => serve(req, res, 'desk')).listen(PORT + 2, '127.0.0.1');
  }

  http.createServer(serve).listen(PORT, PUBLIC_ONLY ? '127.0.0.1' : '0.0.0.0', () => {
    const ip = Object.values(os.networkInterfaces()).flat()
      .find(i => i && i.family === 'IPv4' && !i.internal)?.address || 'localhost';
    if (PUBLIC_ONLY) {
      console.log(`\n  ПУБЛИЧНЫЙ РЕЖИМ: доверенных адресов нет, админка закрыта.`);
      console.log(`  Слушаю ${PORT} — сюда nginx проксирует лендинг.`);
      console.log(`  Слушаю ${PORT + 1} — сюда /admin/ под своим паролем.`);
      console.log(`  Слушаю ${PORT + 2} — сюда /reseption/ под своим паролем.`);
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
