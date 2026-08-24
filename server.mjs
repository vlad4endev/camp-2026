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
import { createHash, randomBytes } from 'node:crypto';
/* Единая база. Без SUPABASE_URL модуль выключен и всё работает на файлах,
   как раньше: переезд включается по одной машине. Подробности в db.mjs. */
import * as db from './db.mjs';
import * as auth from './auth.mjs';

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
/* enter.html и camp-db.js публичны по необходимости, а не по щедрости:
   это дверь и её скрипт, а до входа роль ещё неизвестна — значит отдать
   их можно только тому, у кого роли пока нет. Секретов в них нет:
   страница входа умеет спросить пароль и ничего больше, а camp-db.js
   только читает настройки и ходит в базу под правами, которые выдаёт
   RLS. Из-за этого они видны и телефонам в лагерной Wi-Fi — решено
   осознанно: смотреть там нечего. */
const PUBLIC_FILES = new Set(['landing.html', 'sw.js', 'manifest.webmanifest',
                              'enter.html', 'camp-db.js']);
const PUBLIC_DIRS  = new Set(['icons']);

/* ЗЕРКАЛА БАЗЫ наружу не отдаются НИКОМУ, включая штаб, — но только когда
   единая база включена. Тогда панели читают участников, взносы, записи и
   токены из базы под своими правами (RLS), а эти файлы остаются тем, чем
   они и стали: служебной копией для сервера и ботов. Отдавать их по HTTP
   незачем, а вред очевиден — RLS проверяет staff.off в момент запроса, а
   файл отдался бы любому, у кого на руках ещё живая кука.

   Без базы (лагерь на файлах) всё наоборот: эти файлы И ЕСТЬ данные,
   панель работает прямо с ними, и список ниже не применяется. */
const MIRRORS = new Set(['participants.json', 'signups.json', 'integrations.json',
                         'camp.json', 'outbox.json']);

/* ОГОВОРКА про integrations.json. Зеркалом его называть неточно: db.mjs
   держит на диске только participants.json, signups.json и camp.json, а
   токены ботов с базой живут ТОЛЬКО в ней (панель пишет их через
   CampDB.saveIntegrations и файл не трогает). Значит с включённой базой
   файл на диске — не зеркало, а объедок от файлового режима: он не
   обновляется и врёт тем сильнее, чем дольше лежит.

   В списке он всё равно нужен, и именно поэтому: устаревшие токены
   отдавать по HTTP тем более незачем. Но кто станет читать его С ДИСКА,
   получит не текущие токены — см. bots.mjs. */

/* users.json не отдаётся по HTTP НИКОГДА и НИКОМУ — ни с базой, ни без,
   ни даже с самого 127.0.0.1. Раньше его читала панель: вход был
   клиентским, и файл с хэшами приходилось отдавать в браузер. Теперь
   пароль сверяет сам сервер (auth.verifyLocal), браузеру этот файл не
   нужен ни для чего — а значит и отдавать его незачем.

   Отдельным списком, а не внутри MIRRORS: те закрываются только при
   включённой базе, а этот закрыт всегда. Разница ровно в том, что
   участники без базы — рабочие данные панели, а хэши паролей не
   рабочие данные ни при каком режиме. */
const NEVER = new Set(['users.json']);

/* Две панели. Нужны отдельным списком, чтобы отличить «не твоя страница»
   (человека надо увести туда, где его работа) от «нельзя знать, есть ли
   такой файл» (данные, там только 404). */
const PANELS = new Set(['admin.html', 'reception.html']);

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

   Поэтому в публичном режиме доверенных по адресу нет вообще: сам по себе
   адрес не даёт прав никому. Права даёт вход — кука от POST /session, а её
   ставит только тот, кто предъявил токен Supabase и нашёлся в staff.

   Раньше здесь стояло «админка не открывается ни с какого адреса»: она
   жила на ноутбуке и правила файлы рядом с собой. Теперь панели работают
   по адресу домена, поэтому граница переехала с «откуда пришло» на «кто
   пришёл» — единственную границу, которую можно проверить, когда все
   запросы приходят с одного и того же 127.0.0.1. */
const PUBLIC_ONLY = process.env.CAMP_PUBLIC === '1';

export const trusted = (addr, publicOnly = PUBLIC_ONLY) => !publicOnly && isLocal(addr);

/* Секрет подписи куки. Своей переменной окружения не просим там, где
   есть чем воспользоваться: если service_role утёк, подделка куки — уже
   не главная беда.

   А вот в лагере БЕЗ базы брать нечего, и тогда секрет рождается
   случайным при запуске и живёт только в памяти. Следствие честное:
   перезапустили сервер — все вошедшие вошли заново. Для панели на
   ноутбуке это скорее плюс (секрету негде утечь, на диске его нет), а
   кому мешает — задаёт CAMP_SECRET и получает сессии, переживающие
   перезапуск. */
const SB_URL  = process.env.SUPABASE_URL || '';
const SB_ANON = process.env.SUPABASE_ANON_KEY || '';
const SECRET  = auth.secretFrom(process.env.SUPABASE_SERVICE_KEY || '')
             || auth.secretFrom(process.env.CAMP_SECRET || '')
             || randomBytes(32);

/* Роль из staff → роль сервера. Имена совпадают везде, кроме admin:
   'panel' старше базы и остался в списках доступа и в проверках. */
const SRV_ROLE = { admin:'panel', lead:'lead', desk:'desk', content:'content' };

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

/* ВХОД СЧИТАЕМ ОТДЕЛЬНО И ЖЁСТЧЕ. У /me и /signup частота честно высокая:
   лагерь заезжает, сто телефонов разом спрашивают «кто я и куда записан».
   А у входа высокой частоты не бывает — человек вводит пароль один раз,
   ошибается два. Общий счётчик давал бы 30 попыток пароля в минуту, то
   есть 43 тысячи в сутки на адрес, и это единственная дверь в штаб,
   открытая интернету: для пароля вида «admin/12345» такого запаса
   слишком много.

   Сверх лимита срок блокировки ПРОДЛЕВАЕТСЯ (см. ниже): продолжаешь
   стучать — продолжаешь стоять. Иначе перебор просто ждал бы конца
   окна и получал следующие пять попыток ровно по расписанию.

   Это не заменяет крепкий пароль и тем более Supabase — там перебор
   гасит сама база, и пароль на сервер лагеря вообще не приходит. */
const GUESS = { max: 5, win: 60_000 };

const hits    = new Map();
const guesses = new Map();

export function tooOften(ip, now = Date.now(), store = hits, rate = RATE){
  if (store.size > 5000)
    for (const [k, v] of store) if (now > v.until) store.delete(k);
  const rec = store.get(ip);
  if (!rec || now > rec.until){ store.set(ip, { n:1, until: now + rate.win }); return false; }
  if (++rec.n > rate.max){
    rec.until = now + rate.win;      // стучишь дальше — стоишь дальше
    return true;
  }
  return false;
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
/* Список доступа для лагеря БЕЗ базы. Наружу этот файл не отдаётся
   никогда (его нет ни в PUBLIC_FILES, ни в READ ни одной роли) — с ним
   работает только сам сервер, когда проверяет пароль. */
const USERS    = path.join(ROOT, 'users.json');
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
                          'integrations.json']);

/* СТОЙКА — отдельный пропуск с отдельным паролем. Раздельные пароли сами
   по себе были бы косметикой: с паролем стойки можно было бы открыть
   /reseption/admin.html и получить весь штаб, потому что порт панели
   отдаёт всё. Поэтому у стойки свой порт и свой короткий список.

   Ресепшен правит только участников — значит остального для него не
   существует: ни admin.html, ни лендинга, ни integrations.json с токенами
   ботов. Пароль у стойки — это пароль человека, который принимает деньги,
   а не человека, который правит расписание.

   users.json здесь больше нет и быть не может: вход переехал в Supabase
   Auth, пароли в папке лагеря не лежат вовсе. Раньше файл приходилось
   отдавать стойке — вход шёл по нему, — и это была единственная причина
   держать хэши там, где их видит ресепшен. Причина ушла вместе с файлом. */
const DESK_READ  = new Set(['reception.html', 'camp-db.js', 'enter.html',
                            'participants.json']);
const DESK_WRITE = new Set(['participants.json']);

/* ЧЕТЫРЕ РОЛИ ИЗ ТАБЛИЦЫ staff, а не две. Пока роль определялась портом,
   их и могло быть только две: портов два. Теперь роль приходит из базы
   вместе с человеком, и «вожатый» с «редактором» перестали быть штабом.

   Разница не косметическая. Редактор правит расписание и тексты — списку
   участников в его браузере делать нечего. Вожатому нужны участники, но
   не токены ботов: утёкший токен это чужой бот от имени лагеря. Раньше
   и тот и другой получали всё, потому что у них был пароль от /admin/.

   null — «всё»: у главного ограничений нет, а публичному порту границу
   уже поставил isPublic() выше, второй раз её здесь не пересматриваем. */
const READ = {
  public:  null,
  panel:   null,                                   // 'panel' — это admin из staff
  lead:    new Set(['admin.html', 'reception.html', 'camp-db.js', 'enter.html',
                    'landing.html', 'participants.json', 'signups.json']),
  content: new Set(['admin.html', 'camp-db.js', 'enter.html', 'landing.html']),
  desk:    DESK_READ,
};
const WRITE = {
  panel:   WRITABLE,
  lead:    new Set(['landing.html', 'participants.json']),
  content: new Set(['landing.html']),
  desk:    DESK_WRITE,
};

/* Роль не из таблицы — не роль: отвечаем «нельзя», а не «на всякий случай
   можно». Публичный порт сюда попадает с role='public' и пишет никогда. */
export const canWrite = (name, role = 'panel') =>
  !!(WRITE[role] && WRITE[role].has(name));
export function canRead(role, rel){
  /* Вход не отнимает прав. Что видно человеку с улицы, видно и стойке:
     иначе получалось, что вошедший видит меньше невошедшего — стойка не
     могла открыть landing.html, который лежит открытым для всех. */
  if (isPublic(rel)) return true;
  if (!(role in READ)) return false;
  const only = READ[role];
  return only === null || only.has(rel);
}
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

/* ── 3.75 Вход (GET /dbconfig, POST /session) ──────────────────

   ДВЕ ПОЛОВИНЫ ОДНОЙ ДВЕРИ.

   GET /dbconfig отдаёт адрес проекта и ключ anon. Раньше их вводили
   руками в каждом браузере — лишняя работа на каждом новом устройстве и
   лишний способ ошибиться (перепутать anon с service_role). Теперь
   источник один: окружение сервера.

   ПОЧЕМУ ЭТО МОЖНО ОТДАВАТЬ ВСЕМ. Ключ anon публичный по замыслу: он и
   так уезжает в браузер каждого, кто открывает панель. Он не даёт НИЧЕГО
   сам по себе, и это держится на одном условии — у роли anon в схеме нет
   ни одной политики RLS и ни одного grant execute на функции с security
   definer (claim_seat, whoami: они обходят RLS, и выданные anon
   превратились бы в оракул «есть ли такой номер в лагере», отвечающий
   именем и комнатой). Условие проверяется в supabase/schema.test.sql —
   «anon не видит участников/взносы/записи/токены/расписание». Выдадите
   anon хоть одну политику — этот маршрут в ту же секунду станет дырой.

   POST /session — сам вход. Токен от Supabase Auth в обмен на куку.
   Проверяем токен У БАЗЫ, а не разбором подписи: за подпись отвечает
   тот, кто её ставил. Роль читаем из staff под service_role — не из
   того, что прислал браузер. Подробности про куку — в auth.mjs. */

/* Ключ service_role отличается от anon ОДНИМ полем внутри JWT. Перепутать
   их в окружении — опечатка на одну строку, а последствие: этот маршрут
   публичный, и ключ, обходящий все права, уехал бы каждому, кто спросит.
   Проверку делает и браузер (enter.html), но там она уже поздняя — ключ
   к тому времени покинул сервер. Поэтому не отдаём вовсе. */
export function anonOnly(key){
  try {
    const claims = JSON.parse(Buffer.from(String(key).split('.')[1] || '', 'base64url').toString('utf8'));
    return !claims.role || claims.role === 'anon';
  } catch (_) { return false }          // не разобрали — не отдаём
}

/* Дверь спрашивает этот маршрут первым делом: она не знает заранее, чем
   этот лагерь живёт. Поэтому отвечаем не только настройками, но и тем,
   КАКОЙ здесь вход — «db» (спрашивать e-mail, идти в Supabase) или
   «file» (спрашивать логин, проверять здесь же). Одно поле вместо
   догадок по коду ошибки. */
function dbconfig(send){
  if (!SB_URL || !SB_ANON)
    return send(200, JSON.stringify({ mode:'file' }), JSONT);
  if (!anonOnly(SB_ANON)){
    console.error('  ВНИМАНИЕ: SUPABASE_ANON_KEY — не ключ anon. Не отдаю его наружу.');
    return send(503, JSON.stringify({ ok:false, error:'not_anon' }), JSONT);
  }
  send(200, JSON.stringify({ mode:'db', url: SB_URL, anon: SB_ANON }), JSONT);
}

/* GET /whoami — «я уже вошёл?». Нужен потому, что кука HttpOnly: скрипт
   её не видит, и панель сама ответить на этот вопрос не может. Без
   маршрута получалась бы петля — панель не видит входа, уходит на дверь,
   дверь видит куку у сервера и возвращает в панель, и так по кругу.

   С базой панели спрашивают роль у неё (CampDB.staffMe): там она живая и
   учитывает отключение сотрудника. Здесь роль из куки — снимок на момент
   входа, и для лагеря без базы этого достаточно: список доступа лежит в
   том же файле, что и пароли, и меняется руками. */
function whoami(req, send){
  const sess = SECRET ? auth.who(req, SECRET) : null;      // не 'me': см. serve()
  if (!sess) return send(401, JSON.stringify({ ok:false, error:'no_session' }), JSONT);
  /* Имени в куке нет — она короткая нарочно. Для входа из файла имя
     лежит рядом, в том же users.json; для базы его знает панель. */
  const login = sess.uid.startsWith('file:') ? sess.uid.slice(5) : '';
  const u = login && readJson(USERS).find(x => x && x.login === login);
  send(200, JSON.stringify({ ok:true, role: sess.role, login,
                             name: (u && u.name) || login }), JSONT);
}

/* Кука одна на оба входа, поэтому и выдача одна. */
function grant(res, send, uid, role, name){
  let token;
  try { token = auth.sign(uid, role, SECRET); }
  catch (err) { return send(500, JSON.stringify({ ok:false, error:err.message }), JSONT) }
  res.writeHead(200, {
    'Content-Type': JSONT,
    'Cache-Control': 'no-store',
    'Set-Cookie': auth.setCookie(token, { secure: PUBLIC_ONLY }),
  }).end(JSON.stringify({ ok:true, role, name: name || '' }));
}

function session(req, res, send){
  if (!SECRET)
    return send(503, JSON.stringify({ ok:false, error:'no_secret' }), JSONT);

  /* ВХОД БЕЗ БАЗЫ. Лагерь в поле, Supabase нет — список доступа это
     users.json рядом с панелью. Строго «или — или»: база настроена —
     файл не читаем вовсе, иначе получилось бы два действующих списка
     доступа и два разных ответа на вопрос «кто здесь главный». */
  if (!db.configured()){
    return body(req, res, send, rec => {
      const me = auth.verifyLocal(readJson(USERS), rec && rec.login, rec && rec.pass);
      /* Один ответ на все случаи — нет логина, не тот пароль, доступ
         отключён: подсказывать, какой из логинов существует, незачем. */
      if (!me) return send(401, JSON.stringify({ ok:false, error:'bad_login' }), JSONT);
      grant(res, send, me.uid, me.role, me.name);
    });
  }

  if (!SB_URL || !SB_ANON)
    return send(503, JSON.stringify({ ok:false, error:'no_db' }), JSONT);

  body(req, res, send, rec => {
    /* body() ловит только синхронные ошибки разбора JSON, поэтому свои
       держим сами: незамеченный отказ здесь означал бы вход без роли. */
    (async () => {
      let who;
      try { who = await auth.verify(rec && rec.access, { url: SB_URL, anon: SB_ANON }); }
      catch (err) { return send(401, JSON.stringify({ ok:false, error:err.message }), JSONT) }

      /* Роль строго по своему uid. Политика staff_read даёт штабу видеть
         ВЕСЬ список — значит запрос без фильтра вернул бы чужую строку и
         чужую роль. Здесь мы вообще под service_role, где политик нет. */
      let rows;
      try {
        rows = await db.select('staff',
          'select=role,off,name&user_id=eq.' + encodeURIComponent(who.uid));
      } catch (err) {
        return send(502, JSON.stringify({ ok:false, error:'база не ответила' }), JSONT);
      }
      const me = rows && rows[0];
      /* В Auth есть, в штабе нет — это не «неверный пароль», а «доступ не
         выдан». Отключённого сотрудника не пускаем тем же ответом. */
      if (!me || me.off || !SRV_ROLE[me.role])
        return send(403, JSON.stringify({ ok:false, error:'not_staff' }), JSONT);

      grant(res, send, who.uid, me.role, me.name);
    })();
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

/* РОЛЬ ЗАПРОСА. Раньше её задавал порт: 8001 — штаб, 8002 — стойка, и
   снаружи на них вели два location под двумя паролями. Схема была честная,
   но у неё есть следствие, которое не обойти: auth_basic в nginx
   срабатывает ДО того, как отдан первый байт. Значит пароль выбирал роль
   раньше, чем могла загрузиться страница входа, — и «единая дверь, которая
   сама определяет роль» при таком порядке невозможна. Пароль БЫЛ ролью.

   Теперь порядок обратный: сначала человек входит (enter.html → Supabase →
   POST /session), потом сервер читает его роль из staff и ставит куку, и
   только после этого решает, что отдавать. Роль берём из куки — она
   подписана HMAC на секрете, которого нет ни у кого, кроме сервера
   (auth.mjs). Заголовку по-прежнему не верим: подделать подписанную куку
   нельзя, а незаверенный заголовок можно, и цена ошибки здесь вся админка.

   Порт остаётся вторым источником — для локального запуска на ноутбуке,
   где панель открывают вообще без входа. */
function serve(req, res, portRole = 'public'){
  /* НЕ 'me': так называется обработчик POST /me ниже, и локальная
     переменная его заслоняла — запрос участника «кто я» ронял сервер
     целиком (TypeError: me is not a function). */
  const sess = SECRET ? auth.who(req, SECRET) : null;
  const role = sess ? (SRV_ROLE[sess.role] || 'public') : portRole;
  const local = role !== 'public' || trusted(req.socket.remoteAddress);
  const send = (code, body, type='text/plain; charset=utf-8') =>
    res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-cache' }).end(body);

  const route = req.url.split('?')[0];

  /* Вход и настройки базы — до всех проверок роли: их и спрашивают ровно
     тогда, когда роли ещё нет. /session под ограничителем частоты вместе
     с /me и /signup: это единственная дверь в штаб, открытая интернету, и
     без ограничителя она была бы удобной мишенью для перебора. */
  if (req.method === 'GET' && route === '/dbconfig') return dbconfig(send);
  if (req.method === 'GET' && route === '/whoami')   return whoami(req, send);
  if (route === '/session'){
    if (req.method !== 'POST') return send(405, 'Только POST');
    /* Свой счётчик, а не общий с /me: здесь считают попытки пароля. */
    if (!local && tooOften(whoIP(req), Date.now(), guesses, GUESS))
      return send(429, JSON.stringify({ ok:false, error:'too_often' }), JSONT);
    return session(req, res, send);
  }
  /* Выход: гасим куку на стороне сервера, а не только в браузере. */
  if (req.method === 'POST' && route === '/signout'){
    res.writeHead(200, { 'Content-Type': JSONT, 'Cache-Control':'no-store',
                         'Set-Cookie': auth.clearCookie({ secure: PUBLIC_ONLY }) })
       .end(JSON.stringify({ ok:true }));
    return;
  }

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
  /* Хэши паролей — никому и никогда, даже с loopback. */
  if (NEVER.has(rel))
    return send(404, 'Не найдено');

  /* ПАНЕЛЬ НЕ ПО РОЛИ — УВОДИМ, А НЕ ОТКАЗЫВАЕМ. Три тупика было: не
     вошёл и открыл admin.html — «Не найдено»; регистратура открыла штаб —
     «Не найдено»; редактор открыл ресепшн — то же самое. Пустая страница
     вместо ответа на вопрос «а куда мне тогда?».

     Мы знаем и то, вошёл ли человек, и его роль, и какая панель ей
     подходит. Значит можем ответить по делу: не вошёл — на дверь, вошёл
     не туда — в свою панель.

     Только для этих двух страниц. Данные так уводить нельзя: там 404
     нарочно не подсказывает, существует ли файл. Про сами панели скрывать
     нечего — они лежат в публичном репозитории на виду. */
  if (PANELS.has(rel) && !(local && canRead(role, rel))){
    const to = sess ? (SRV_ROLE[sess.role] === 'desk' ? '/reception.html' : '/admin.html')
                    : '/enter.html';
    if (to !== '/' + rel)
      return res.writeHead(302, { Location: to, 'Cache-Control':'no-store' }).end();
  }

  if (!local && !isPublic(rel))
    return send(404, 'Не найдено');            // 404, а не 403: не подсказываем, что файл есть
  /* Зеркала базы не отдаём никому, включая главного: с базой панели читают
     эти данные из неё, под правами, которые RLS проверяет в момент запроса.
     Файл же отдался бы любому, у кого на руках ещё живая кука. */
  if (db.configured() && MIRRORS.has(rel))
    return send(404, 'Не найдено');
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

  /* ── ПЕРЕБОР ПАРОЛЯ ──
     У входа свой счётчик и он жёстче: у /me частота честно высокая (заезд,
     сто телефонов разом), у входа — нет. */
  a(GUESS.max < RATE.max,                               'вход строже обычных запросов');
  const g2 = new Map();
  a(Array.from({ length:5 }, () => tooOften('ip', t0, g2, GUESS)).every(v => v === false),
                                                        'пять попыток пароля проходят');
  a(tooOften('ip', t0, g2, GUESS),                      'шестая отбита');
  /* Главное здесь: продолжая стучать, перебор НЕ дожидается конца окна.
     Каждая отбитая попытка отодвигает срок, поэтому «пять в минуту»
     нельзя превратить в «пять каждую минуту по расписанию». */
  a(tooOften('ip', t0 + 59_000, g2, GUESS),             'стук внутри окна продлевает блокировку');
  a(tooOften('ip', t0 + 118_000, g2, GUESS),            'и продлевает снова');
  a(!tooOften('ip', t0 + 118_000 + 60_001, g2, GUESS),  'после минуты тишины снова можно');
  /* Счётчики не общие: попытки пароля не съедают лимит участников. */
  const g3 = new Map(), h3 = new Map();
  Array.from({ length:6 }, () => tooOften('ip', t0, g3, GUESS));
  a(!tooOften('ip', t0, h3),                            'перебор входа не блокирует /me участникам');
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
  /* every(n => canWrite(n)), а не every(canWrite): вторым аргументом
     every отдаёт индекс, и роль стала бы числом. Раньше это сходило —
     «любая роль, кроме desk» означало штаб; теперь роль не из списка
     это отказ, и ошибка перестала быть незаметной. */
  a(['landing.html','participants.json','integrations.json'].every(n => canWrite(n)),
                                                        'панель пишет свои три файла');
  /* Вход переехал в Supabase Auth: файла с хэшами больше нет, и записать
     его через PUT нельзя — иначе он бы вернулся вторым списком доступа. */
  a(!canWrite('users.json') && !canWrite('users.json','desk'),
                                                        'users.json панель не пишет вовсе');
  a(['server.mjs','bots.mjs','sw.js','manifest.webmanifest','signups.json',
     'landing.backup.html','.gitignore','../landing.html','icons/icon-192.png',
     'landing.html.tmp','participants.json.tmp'].every(n => !canWrite(n)),
                                                        'ничего другого панель перезаписать не может');
  a(!canWrite('') && !canWrite('..') && !canWrite('.'),  'пустое имя и точки не проходят');

  /* Стойка и штаб разделены не паролем, а тем, что за паролем видно.
     Иначе с паролем стойки открывался бы /reseption/admin.html. */
  a(['reception.html','camp-db.js','participants.json']
      .every(n => canRead('desk', n)),                  'стойке видно то, что ей нужно');
  a(!canRead('desk', 'users.json'),                     'users.json стойке не отдаётся');
  /* landing.html и sw.js из этого списка ушли: они лежат открытыми для
     всего интернета, и прятать их от вошедшей стойки было бессмысленно —
     она видела бы меньше, чем прохожий. Граница со стойкой не в том, что
     ей не видно лендинг, а в том, что она не может его ПЕРЕЗАПИСАТЬ:
     это canWrite, и оно проверяется ниже. */
  a(['admin.html','integrations.json','signups.json','server.mjs',
     'backups/participants-1.json'].every(n => !canRead('desk', n)),
                                                        'стойке штаб и чужие данные не видны');
  a(['admin.html','landing.html','integrations.json'].every(n => canRead('panel', n)),
                                                        'штабу видно всё своё');
  a(canWrite('participants.json','desk'),               'стойка правит участников');
  a(['landing.html','integrations.json'].every(n => !canWrite(n,'desk')),
                                                        'стойка не правит ни лендинг, ни токены');
  a(canWrite('landing.html','panel') && canWrite('landing.html'),
                                                        'штаб правит лендинг, роль по умолчанию — штаб');

  /* ── ЧЕТЫРЕ РОЛИ ИЗ staff ──
     Пока роль была портом, «вожатый» и «редактор» получали весь штаб:
     у них был пароль от /admin/. Теперь у каждого своё. */
  a(canRead('lead', 'participants.json') && canRead('lead', 'admin.html'),
                                                        'вожатому видны участники и штаб');
  a(!canRead('lead', 'integrations.json'),              'вожатому токены ботов не видны');
  a(canRead('content', 'landing.html') && canRead('content', 'admin.html'),
                                                        'редактору видна страница лагеря');
  a(['participants.json','signups.json','integrations.json']
      .every(n => !canRead('content', n)),              'редактору личные данные не видны');
  a(canWrite('landing.html','content') && !canWrite('participants.json','content'),
                                                        'редактор правит лендинг, но не людей');
  a(canWrite('participants.json','lead') && !canWrite('integrations.json','lead'),
                                                        'вожатый правит людей, но не токены');
  /* Роль не из таблицы — отказ, а не «на всякий случай можно». Раньше
     canWrite() отдавал штаб всему, что не 'desk', включая опечатку. */
  /* undefined в список не входит намеренно: это «аргумент не передали», и
     там срабатывает роль по умолчанию — штаб (проверка выше). */
  a(['КОРОЛЬ','','public',null,0].every(r => !canWrite('landing.html', r)),
                                                        'выдуманная роль не пишет ничего');
  a(['КОРОЛЬ','',null,undefined].every(r => !canRead(r, 'admin.html')),
                                                        'выдуманная роль не читает ничего');
  /* Публичный порт границу проходит выше, в isPublic(): canRead() его не
     пересматривает, иначе лендинг перестал бы отдаваться вовсе. */
  a(canRead('public', 'landing.html') && canRead('public', 'enter.html'),
                                                        'публичной роли canRead() не мешает');
  /* Дверь и её скрипт обязаны быть публичными: до входа роли ещё нет. */
  a(isPublic('enter.html') && isPublic('camp-db.js'),   'дверь открывается без входа');
  /* Вход не отнимает прав: до этой проверки стойка не могла открыть
     landing.html, лежащий открытым для всего интернета. */
  a(['landing.html','enter.html','camp-db.js','icons/icon-192.png']
      .every(n => canRead('desk', n)),                  'вошедший видит не меньше невошедшего');
  a(!isPublic('admin.html') && !isPublic('reception.html'),
                                                        'сами панели без входа не отдаются');

  /* ── КУКА ──
     Здесь только стык с сервером: подпись, срок и подмена роли проверены
     отдельно в auth.mjs --selftest. */
  const S2 = auth.secretFrom('ключ');
  const ck = t => ({ headers:{ cookie:'camp=' + t }, socket:{ remoteAddress:'8.8.8.8' } });
  a(auth.who(ck(auth.sign('u1','desk',S2)), S2).role === 'desk', 'кука стойки читается');
  a(SRV_ROLE.admin === 'panel' && SRV_ROLE.desk === 'desk',      'admin из базы — это panel');
  a(Object.keys(SRV_ROLE).every(r => auth.ROLES.has(r)),
                                                        'все роли сервера есть в auth.mjs');
  a(Object.values(SRV_ROLE).every(r => r in READ && r in WRITE),
                                                        'у каждой роли есть свои списки');
  a(auth.who({ headers:{} }, S2) === null,              'без куки роли нет');

  /* ── ЗЕРКАЛА БАЗЫ ──
     С базой эти файлы по HTTP не уходят никому, включая главного: данные
     панели берут из базы, где права проверяются в момент запроса. */
  a(['participants.json','signups.json','integrations.json','camp.json','outbox.json']
      .every(n => MIRRORS.has(n)),                      'все зеркала перечислены');
  a(!MIRRORS.has('landing.html') && !MIRRORS.has('admin.html'),
                                                        'код зеркалом не считается');

  /* ── ХЭШИ ПАРОЛЕЙ ──
     users.json нужен только серверу: пароль он сверяет сам. Браузеру не
     нужен ни в каком режиме, поэтому и не отдаётся — даже с loopback,
     где всё остальное открыто. Раньше файл читала панель, и это была
     единственная причина его отдавать. */
  a(NEVER.has('users.json'),                            'хэши паролей закрыты всегда');
  a(!NEVER.has('participants.json'),                    'участники — не хэши, режим решает');
  a(!isPublic('users.json') && !canRead('desk', 'users.json') && !canRead('lead', 'users.json'),
                                                        'users.json не значится ни в одном списке чтения');
  a(!canWrite('users.json') && !canWrite('users.json', 'desk'),
                                                        'users.json нельзя и перезаписать');

  /* ── НЕ ТА ПАНЕЛЬ ──
     Своя страница у каждой роли есть; чужую отдавать нельзя, но и тупик
     показывать незачем — уводим туда, где эта роль работает. */
  a(PANELS.has('admin.html') && PANELS.has('reception.html'),
                                                        'обе панели в списке «уводим, а не отказываем»');
  a(['participants.json','users.json','integrations.json','landing.html','enter.html']
      .every(n => !PANELS.has(n)),                      'данные так не уводятся — там только 404');
  /* Каждая роль должна иметь ХОТЬ ОДНУ панель, иначе увод зациклится:
     404 → редирект на страницу, которая тоже 404. */
  a(['panel','lead','content','desk'].every(r =>
      canRead(r, 'admin.html') || canRead(r, 'reception.html')),
                                                        'у каждой роли есть своя панель');
  a(canRead('desk', 'reception.html') && !canRead('desk', 'admin.html'),
                                                        'стойку уводит на ресепшн');
  a(canRead('content', 'admin.html') && !canRead('content', 'reception.html'),
                                                        'редактора уводит в штаб');

  /* ── КЛЮЧ НАРУЖУ ──
     GET /dbconfig публичный, поэтому единственная опечатка в окружении
     («вставил service_role вместо anon») отдала бы интернету ключ,
     обходящий все права. Проверяем поле role внутри JWT. */
  const jwt = role => 'eyJhbGciOiJIUzI1NiJ9.' +
    Buffer.from(JSON.stringify(role ? { role } : {})).toString('base64url') + '.sig';
  a(anonOnly(jwt('anon')),                              'ключ anon отдаётся');
  a(!anonOnly(jwt('service_role')),                     'service_role наружу не уходит');
  a(!anonOnly(jwt('authenticated')),                    'чужая роль в ключе — тоже отказ');
  a(['', 'мусор', 'a.b.c', null, undefined].every(k => !anonOnly(k)),
                                                        'неразобранный ключ не отдаётся');

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

/* ── 5.5 ЖИВЫЕ МАРШРУТЫ ───────────────────────────────────────────

   Всё выше проверяет отдельные функции. А этот раздел поднимает сервер и
   стучится в него по-настоящему, потому что ровно так была пропущена
   поломка, которую никакая проверка функций не увидела бы: локальная
   переменная в serve() назвалась `me` и заслонила обработчик POST /me.
   Синтаксис верный, функции по отдельности целые, 137 проверок зелёные —
   а первый же запрос участника «кто я» ронял процесс целиком.

   Поэтому: только чтение и заведомо отбраковываемые запросы. Ни одна
   проверка здесь не должна менять файлы лагеря — selftest гоняется и на
   сервере, перед выкладкой (deploy/pull.sh). */

async function smoke(){
  const a = (ok, what) => { console.log((ok ? '  ok   ' : '  ПЛОХО') + '  ' + what);
                            if (!ok) process.exitCode = 1; };
  const srv = http.createServer((req, res) => serve(req, res, 'public'));
  await new Promise(ok => srv.listen(0, '127.0.0.1', ok));
  const base = 'http://127.0.0.1:' + srv.address().port;

  const hit = async (path, opt = {}) => {
    try {
      const r = await fetch(base + path, { redirect:'manual', ...opt });
      return r.status;
    } catch (err) { return 'СЕРВЕР УПАЛ: ' + err.message }
  };
  const post = (path, obj) => hit(path, { method:'POST',
    headers:{ 'Content-Type':'application/json' }, body: JSON.stringify(obj) });

  console.log('\nЖИВЫЕ МАРШРУТЫ');

  /* Та самая поломка. Ответ по существу не важен — важно, что сервер
     ответил, а не умер: 404 «нет такого номера» здесь тоже успех. */
  a([200, 404, 429].includes(await post('/me', { phone:'+70000000000' })),
                                                        'POST /me отвечает, а не роняет сервер');
  a([400, 429].includes(await post('/signup', {})),      'POST /signup разбирает мусор');
  a(await hit('/seats') === 200,                        'GET /seats жив');
  a(await hit('/camp') === 200,                         'GET /camp жив');
  a(await hit('/enter.html') === 200,                   'дверь открывается');

  /* Вход. Настроек базы в проверке нет, поэтому режим файловый: пароль
     заведомо не подойдёт, и это ровно то, что проверяем — отказ, а не
     сбой и не пропуск. */
  a([401, 429, 503].includes(await post('/session', { login:'нет-такого', pass:'нет' })),
                                                        'вход с чужим паролем не выдаётся');
  a([401, 405].includes(await hit('/session')),         'GET на вход не работает');
  a(await hit('/whoami') === 401,                       'без куки /whoami молчит');

  /* Хэши паролей — даже здесь, с loopback, где всё остальное открыто. */
  a(await hit('/users.json') === 404,                   'users.json не отдаётся и с loopback');

  /* Выход за пределы папки. Пишем %2e%2e, а не «..»: обычные точки fetch
     сворачивает сам, ещё до отправки, и до сервера дошло бы безобидное
     /server.mjs. Проверять надо то, что сервер реально получит. */
  a([403, 404].includes(await hit('/%2e%2e/%2e%2e/etc/passwd')),
                                                        'из папки не выйти');
  a([403, 404].includes(await hit('/icons/%2e%2e/%2e%2e/etc/passwd')),
                                                        'из разрешённой папки тоже не выйти');

  srv.close();
  console.log('');
}

if (process.argv.includes('--selftest')) { selftest(); await smoke(); }
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
  /* ОДИН ПОРТ. Раньше их было три: 8001 для штаба и 8002 для стойки
     поднимались отдельно, потому что роль определялась портом, а порт из
     интернета не подделать. Роль теперь приходит из подписанной куки
     (auth.mjs), и второй с третьим портом стали способом сказать то же
     самое дважды. Убраны вместе с двумя location под Basic auth в nginx —
     одним коммитом, чтобы штаб не постоял открытым между выкладками. */

  http.createServer(serve).listen(PORT, PUBLIC_ONLY ? '127.0.0.1' : '0.0.0.0', () => {
    const ip = Object.values(os.networkInterfaces()).flat()
      .find(i => i && i.family === 'IPv4' && !i.internal)?.address || 'localhost';
    if (PUBLIC_ONLY) {
      console.log(`\n  ПУБЛИЧНЫЙ РЕЖИМ: адрес прав не даёт, права даёт вход.`);
      console.log(`  Слушаю ${PORT} — сюда nginx проксирует всё.`);
      console.log(`  Дверь: /enter.html → POST /session → кука с ролью из staff.`);
      if (!SECRET) console.log(`  ВНИМАНИЕ: нет SUPABASE_SERVICE_KEY — вход не выдаётся.`);
      if (!SB_ANON) console.log(`  ВНИМАНИЕ: нет SUPABASE_ANON_KEY — /dbconfig молчит.`);
    } else {
      console.log(`\n  Вход:      http://localhost:${PORT}/enter.html`);
      console.log(`  Участникам: http://${ip}:${PORT}/landing.html`);
    }
    console.log(`  В сеть отдаются только: ${[...PUBLIC_FILES].join(', ')}, ` +
                `${[...PUBLIC_DIRS].map(d => d + '/*').join(', ')}`);
    console.log(`  Записи на мастер-классы принимаются в signups.json ` +
                `(${readSignups().length} шт.) — смотреть в админке\n`);
  });
}
