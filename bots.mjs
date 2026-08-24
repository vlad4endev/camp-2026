/* Боты лагеря: Telegram + MAX. Один модуль на оба.

       TG_TOKEN=... MAX_TOKEN=... node bots.mjs
       node bots.mjs --selftest      (проверка без сети)

   Зачем: лендинг открывается только в лагерной Wi-Fi. Бот — второй канал:
   он же работает из дома, из дороги и с телефона родителя. Мини-приложений
   нет специально — всё живёт в самом чате, инлайн-кнопками.

   Данные НЕ дублируются. Бот читает те же файлы, что и страница:
     landing.html      → const CAMP: дни, расписание, объявления, классы
     participants.json → комнаты и соседи; бот дописывает в него ровно
                         три поля: tgId, maxId и ник tg, если он пуст
     signups.json      → записи на мастер-классы (только чтение)
     rooms.json        → куда идти: {"12":"2 этаж, направо от лестницы"}
                         файла нет — бот просто покажет номер комнаты
   Записывает бот ровно одно: bots.json — привязку «аккаунт → участник».
   Запись на мастер-класс уходит POST /signup на server.mjs, чтобы в
   signups.json по-прежнему писал ровно один процесс.

   Токены только из окружения: в папке лежит лендинг, который раздаётся
   в сеть, — токенам там не место.                                       */

import fs   from 'node:fs';
import path from 'node:path';
import os   from 'node:os';
/* Единая база. Без SUPABASE_URL выключена, и бот пишет в файлы,
   как раньше. Читает он по-прежнему из файлов: при включённой базе
   это зеркало, которое обновляет server.mjs. */
import * as db from './db.mjs';
/* Содержимое лагеря разбираем общей функцией: своя копия регулярки
   разошлась бы с сервером молча — бот отвечал бы вчерашним расписанием. */
import { parseCamp } from './camp.mjs';

const ROOT      = import.meta.dirname;
const PORT      = Number(process.env.CAMP_PORT) || 8000;
/* Токены. Сначала integrations.json рядом — его пишет штаб в панели
   («Доступ → Интеграции»), и это единственный способ сменить токен,
   не заходя на сервер по ssh. Потом переменные окружения: запуск из
   консоли остаётся прежним, а на сервере /etc/camp.env продолжает
   работать, пока файла ещё нет.

   Заполненный, но выключенный в панели бот — это выключенный бот, а не
   повод молча вернуться к переменной окружения. Иначе выключатель не
   выключал бы: человек снял галочку, увидел «выключено» и ушёл, а бот
   отвечает участникам как ни в чём не бывало. */
const INTEG = (() => {
  try{ return JSON.parse(fs.readFileSync(path.join(ROOT, 'integrations.json'), 'utf8')); }
  catch(_){ return {}; }               // файла нет или он битый — работаем на окружении
})();
export const pickToken = (blk, envVal) =>
  blk && blk.token ? (blk.on === false ? '' : String(blk.token).trim())
                   : (envVal || '');
/* С базой источник токенов — она, а файл не в счёт. Панель с базой
   пишет только в таблицу integrations (admin.html:1184), а db.mjs
   зеркалит на диск участников и записи, но не токены — значит лежащий
   рядом integrations.json с базой не обновляет никто и он тихо стареет.
   Прочитать его в этом режиме хуже, чем не читать: главный сменил бы
   токен в панели, увидел «сохранено», а бот продолжил бы со старым.
   И выключатель перестал бы выключать — в файле осталось бы on:true.

   Поэтому «или — или», как у входа: есть база — только база; нет базы —
   только файл. Переменная окружения остаётся в обоих случаях: это не
   залежавшийся артефакт, а осознанное действие того, кто запускает. */
export const tokenSource = (dbOn, doc, file) => dbOn ? (doc || {}) : (file || {});

let TG_TOKEN  = pickToken(INTEG.telegram, process.env.TG_TOKEN);
let MAX_TOKEN = pickToken(INTEG.max,      process.env.MAX_TOKEN);
let PROXY     = INTEG.proxy;

/* Спрашиваем базу при запуске, а не при импорте: --selftest обещан
   «без сети», и обещание надо держать. */
async function resolveTokens(){
  if (!db.configured()) return;
  let doc = null;
  try{
    const rows = await db.select('integrations', 'id=eq.1&select=doc');
    doc = (Array.isArray(rows) && rows[0] && rows[0].doc) || {};
  }catch(err){
    console.error('Интеграции из базы не прочитались: ' + err.message);
    console.error('Файл рядом в этом режиме не подхватываем — он устарел. Остаётся окружение.');
  }
  const src = tokenSource(true, doc, INTEG);
  TG_TOKEN  = pickToken(src.telegram, process.env.TG_TOKEN);
  MAX_TOKEN = pickToken(src.max,      process.env.MAX_TOKEN);
  PROXY     = src.proxy;
  tg.token  = TG_TOKEN;
  max.token = MAX_TOKEN;
}
/* кто имеет право на ручную рассылку: CAMP_ADMINS='tg:123456,max:789' */
const ADMINS = new Set((process.env.CAMP_ADMINS || '').split(',').map(s => s.trim()).filter(Boolean));

const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ── 1. Чтение данных лагеря ──────────────────────────────────
   Кэш по mtime: расписание дёргают часто, а файл на 285 КБ.
   Не разобрался файл (админка пишет его прямо сейчас) — отдаём
   прошлую удачную версию, а не роняем бота. */
function cached(file, parse, def){
  let mt = -1, val = def;
  return () => {
    const abs = path.join(ROOT, file);
    let m; try { m = fs.statSync(abs).mtimeMs; } catch { return val; }
    if (m !== mt) {
      mt = m;
      try { val = parse(fs.readFileSync(abs, 'utf8')); }
      catch (err) { console.error(`${file}: ${err.message}`); }
    }
    return val;
  };
}


const readCamp    = cached('landing.html',      parseCamp,      null);
const readPeople  = cached('participants.json', t => JSON.parse(t) || [], []);
const readSignups = cached('signups.json',      t => JSON.parse(t) || [], []);
const readRooms   = cached('rooms.json',        t => JSON.parse(t) || {}, {});

/* ── 2. Кто это написал ───────────────────────────────────────
   Сверяем последние 10 цифр: +7, 8 и пробелы в списке участников
   пишут кто как. Отказавшиеся не считаются участниками. */
export const tail = s => String(s ?? '').replace(/\D/g, '').slice(-10);

export function findPerson(people, phone){
  const t = tail(phone);
  return t.length === 10
    ? people.find(p => tail(p.phone) === t && p.status !== 'cancelled') || null
    : null;
}

/* ── 3. Привязки (единственное, что пишет бот) ────────────────
   users: 'tg:12345' → {chat, phone, name}
   ann/cls: что уже разослано, чтобы при перезапуске не слать повторно */
const LINKS = path.join(ROOT, 'bots.json');
let L = { users:{}, ann:[], cls:{} };
try { L = { ...L, ...JSON.parse(fs.readFileSync(LINKS, 'utf8')) }; } catch { /* первый запуск */ }

let saveTimer;
function saveLinks(){                    // пачкой: нажатий кнопок много, диск один
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      fs.writeFileSync(LINKS + '.tmp', JSON.stringify(L, null, 2));
      fs.renameSync(LINKS + '.tmp', LINKS);
    } catch (err) { console.error('bots.json:', err.message); }
    mirrorLinks();
  }, 500);
}

/* bots.json остаётся у бота: «что уже разослано» — состояние процесса,
   базе про него знать нечего. А вот привязка «аккаунт → участник» —
   общее знание, и штаб должен видеть, кто подключил бота. Поэтому её
   отражаем в bot_links. По возможности: не вышло — не беда, работа
   бота от этого не зависит. */
function mirrorLinks(){
  if (!db.configured()) return;
  const rows = Object.entries(L.users || {}).map(([account, u]) => ({
    account,
    phone_key: String((u && u.phone) || '').replace(/\D/g, '').slice(-10) || null,
    participant_id: (personOf(account) || {}).id || null,
  }));
  if (rows.length)
    db.upsert('bot_links', rows).catch(err => console.error('bot_links:', err.message));
}

const personOf = key => {
  const u = L.users[key];
  return u ? findPerson(readPeople(), u.phone) : null;
};
/* ── 3.5 Обратная запись: id мессенджеров в карточку участника ──
   Единственное место, где бот трогает чужой файл. Пишем пачкой раз в
   полминуты и только при заезде (первая привязка), потому что админка
   считает чужую запись конфликтом и останавливает автосохранение —
   один тост на заезд стерпим, двадцать нет.

   Правки штаба при этом не теряются: перечитываем файл прямо перед
   записью и меняем ровно свои три поля, не подставляя ничего из памяти.
   ponytail: окно гонки ~1 мс; если админка начнёт писать чаще, отдавать
   participants.json должен один процесс — сервер. */
const PEOPLE_FILE = path.join(ROOT, 'participants.json');

export function applyIds(list, patches){
  let n = 0;
  for (const p of list) {
    const patch = patches[tail(p.phone)];
    if (!patch) continue;
    for (const [k, v] of Object.entries(patch)) {
      if (v === null) { if (k in p) { delete p[k]; n++; } continue; }   // отвязался — стираем
      if (!v || p[k] === v) continue;
      if (k === 'tg' && String(p.tg ?? '').trim()) continue;   // ник, вписанный штабом, важнее
      p[k] = v; n++;
    }
  }
  return n;
}

/* через .tmp + rename: админка не должна прочитать список на середине записи */
export function writeIds(patches, file = PEOPLE_FILE){
  if (!Object.keys(patches).length || !fs.existsSync(file)) return 0;   // списка ещё нет — это не ошибка
  try {
    const list = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!Array.isArray(list)) return 0;
    const n = applyIds(list, patches);
    if (!n) return 0;
    fs.writeFileSync(file + '.tmp', JSON.stringify(list, null, 2));
    fs.renameSync(file + '.tmp', file);
    return n;
  } catch (err) { console.error('participants.json:', err.message); return 0; }
}

let pending = {}, flushT;
function noteIds(phone, patch){
  pending[phone] = { ...pending[phone], ...patch };
  clearTimeout(flushT);
  flushT = setTimeout(flushIds, 30000);
}
async function flushIds(){
  const todo = pending;
  pending = {};

  /* С базой пишем туда, а не в зеркало: следующий pull() затёр бы файл.
     Правило приоритета при этом одно и то же — прогоняем applyIds по
     копии и отправляем получившуюся разницу. Иначе «ник, вписанный
     штабом, важнее» пришлось бы повторять здесь второй раз, и однажды
     эти две копии разошлись бы. */
  if (db.configured()){
    const people = readPeople();
    const copy   = JSON.parse(JSON.stringify(people));
    if (!applyIds(copy, todo)) return;
    let n = 0;
    for (let i = 0; i < copy.length; i++){
      const was = people[i], now = copy[i], fields = {};
      for (const k of ['tg', 'tgId', 'maxId'])
        if (JSON.stringify(was[k] ?? null) !== JSON.stringify(now[k] ?? null))
          fields[k] = now[k] ?? null;
      if (Object.keys(fields).length && now.id){
        try { await db.savePerson(now.id, fields); n++; }
        catch (err) { console.error('база:', err.message); }
      }
    }
    if (n) console.log(`база: дописано участников — ${n}`);
    return;
  }

  const n = writeIds(todo);
  if (n) console.log(`participants.json: дописано полей — ${n}`);
}

/* Личность в записях — номер телефона, тот же самый, что присылает
   лендинг с телефона. Поэтому запись из бота и запись со страницы —
   одна и та же строка, и один человек не занимает два места. */
const phoneOf = key => (L.users[key] || {}).phone || '';

/* ── 4. Тексты ────────────────────────────────────────────────
   Без разметки: у Telegram и MAX она разная, а экранирование —
   лишний источник багов. Эмодзи хватает. */
const MONTH = ['','января','февраля','марта','апреля','мая','июня',
               'июля','августа','сентября','октября','ноября','декабря'];
/* <br> в текстах лендинга — это перенос строки, а не пустое место:
   без замены два предложения слипаются в одно. */
const plain = s => String(s ?? '')
  .replace(/<br\s*\/?>|<\/p>|<\/div>/gi, '\n')
  .replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ')
  .replace(/[ \t]+\n/g, '\n').trim();
const cut   = (s, n = 3500) => s.length > n ? s.slice(0, n - 1) + '…' : s;

export function dayText(camp, i, now = new Date()){
  const d = camp.days[i];
  if (!d) return 'Такого дня в программе нет.';
  const live = new Set(timeline(camp)
    .filter(x => x.di === i && x.start <= now && now < (x.end || new Date(+x.start + 30 * 6e4)))
    .map(x => x.ev));
  const head = `📅 ${d.date} ${MONTH[camp.month]}, ${d.dow} — ${d.theme}\n${d.tagline}`;
  const rows = d.events.map(e =>
    `${live.has(e.ev) ? '🔴 ' : ''}${e.t}${e.e ? '–' + e.e : '     '}  ${e.ev}`);
  return cut(head + '\n\n' + rows.join('\n'));
}

/* какой день лагеря сегодня; -1 — ещё не начался или уже кончился */
export function todayIndex(camp, now = new Date()){
  return camp.days.findIndex(d => now.getFullYear() === camp.year
    && now.getMonth() === camp.month - 1 && now.getDate() === d.date);
}

export function datesText(camp){
  const ds = camp.days.map(d => d.date);
  return `${Math.min(...ds)}–${Math.max(...ds)} ${MONTH[camp.month]} ${camp.year}`;
}

export function themesText(camp, now = new Date()){
  const t = todayIndex(camp, now);
  return '🌲 Тематика дней\n\n' + cut(camp.days
    .map((d, i) => `${i === t ? '• ' : ''}${d.date} ${d.dow} — ${d.theme}\n${d.tagline}`)
    .join('\n\n'));
}

export function helpText(camp){
  const h = camp.texts.help, f = camp.texts.footer;
  return ['✍️ ' + h.title, plain(h.sub),
          camp.tg ? `Организатор: @${camp.tg}` : '',
          plain(h.note),
          `📍 ${camp.place}\n🗓 ${datesText(camp)}`].filter(Boolean).join('\n\n');
}

export function roomText(people, p, rooms = {}, mine = []){
  const room = String(p.room ?? '').trim();
  if (!room) return `🏠 Комнату вам ещё не назначили. Как заселят — покажу здесь.`;
  const mates = people.filter(x => x !== p && String(x.room ?? '').trim() === room
                                && x.status !== 'cancelled');
  return `🏠 Комната ${room}${rooms[room] ? ' · ' + rooms[room] : ''}\n`
       + (mates.length ? 'Соседи: ' + mates.map(x => x.name).join(', ') : 'Пока вы там один.')
       + (mine.length ? '\n🎨 Ваши мастер-классы: ' + mine.join(', ') : '');
}

/* ── Расписание в абсолютном времени ──────────────────────────
   В CAMP у события только 'ЧЧ:ММ'. Правило лендинга: время меньше
   предыдущего — это уже следующие сутки, иначе «00:00 Отбой» уехал
   бы в начало дня и бот звал бы спать в обед. */
export function timeline(camp){
  const out = [];
  for (const d of camp.days) {
    let prev = -1, shift = 0;
    for (const e of d.events) {
      const [h, m] = String(e.t).split(':').map(Number);
      if (!(h >= 0 && m >= 0)) continue;
      if (h * 60 + m < prev) shift = 1;
      prev = h * 60 + m;
      const start = new Date(camp.year, camp.month - 1, d.date + shift, h, m);
      let end = null;
      if (e.e) {
        const [H, M] = String(e.e).split(':').map(Number);
        end = new Date(camp.year, camp.month - 1, d.date + shift, H, M);
        if (end <= start) end = new Date(+end + 864e5);      // событие через полночь
      }
      out.push({ ev:e.ev, start, end, di: camp.days.indexOf(d) });
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

const hhmm = d => String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');

export function nowText(camp, now = new Date()){
  const t = timeline(camp);
  if (!t.length) return '';
  /* у события без конца считаем «идёт» полчаса — как раз общий сбор или фото */
  const cur  = t.filter(x => x.start <= now && now < (x.end || new Date(+x.start + 30 * 6e4)));
  const next = t.filter(x => x.start > now).slice(0, 2);
  if (!cur.length && !next.length) return '🏁 Лагерь закончился. До встречи!';

  const when = d => {
    const day = x => new Date(x.getFullYear(), x.getMonth(), x.getDate());
    const diff = Math.round((day(d) - day(now)) / 864e5);
    return (diff === 0 ? '' : diff === 1 ? 'завтра ' : `${d.getDate()} ${MONTH[d.getMonth() + 1]} `) + hhmm(d);
  };
  const lines = [];
  if (cur.length) lines.push(`🔴 Сейчас: ${cur.map(x => x.ev).join(', ')}`
                             + (cur[0].end ? ` (до ${hhmm(cur[0].end)})` : ''));
  else if (now < t[0].start) lines.push(`Лагерь начнётся ${when(t[0].start)}.`);
  if (next.length) lines.push((cur.length ? 'Дальше:\n' : 'Ближайшее:\n')
                              + next.map(x => `· ${when(x.start)} — ${x.ev}`).join('\n'));
  return lines.join('\n\n');
}

/* Первое сообщение после привязки: минимум личного и что прямо сейчас. */
function cardText(camp, key, mine = []){
  const p = personOf(key);
  const now = nowText(camp);
  if (!p) return ['Здесь всё про лагерь: программа, объявления, ваша комната и запись '
                  + 'на мастер-классы.', now].filter(Boolean).join('\n\n');
  return [`Привет, ${p.name}! Вы в лагере — вот главное.`,
          roomText(readPeople(), p, readRooms(), mine),
          now].filter(Boolean).join('\n\n');
}

const annText = camp => '📢 Объявления\n\n' + cut(camp.announcements
  .slice().sort((a, b) => (b.pin ? 1 : 0) - (a.pin ? 1 : 0) || String(b.at).localeCompare(a.at))
  .slice(0, 6)
  .map(a => `${a.pin ? '📌 ' : ''}${a.title}\n${plain(a.text)}`).join('\n\n'));

const infoText = camp => 'ℹ️ Полезное\n\n' + cut(camp.info
  .map(x => `${x.title}\n${plain(x.txt)}`).join('\n\n'));

const classText = c => [c.name, plain(c.txt),
                        [c.when && '🕒 ' + c.when, c.where && '📍 ' + c.where, c.who && '👤 ' + c.who]
                          .filter(Boolean).join('\n')].filter(Boolean).join('\n');

/* ── 5. Экраны ────────────────────────────────────────────────
   render() возвращает {text, kb} — одинаково и для нового сообщения,
   и для правки старого. kb: массив рядов, кнопка = {text, data|url}. */
const BACK = { text:'‹ Меню', data:'menu' };

function menuKb(plat, camp){
  const rows = [
    [{ text:'📅 Расписание', data:'days' }, { text:'📢 Объявления', data:'ann' }],
    [{ text:'🏠 Моя комната', data:'room' }, { text:'🎨 Мастер-классы', data:'cls' }],
    [{ text:'🌲 Тематика дней', data:'themes' }, { text:'ℹ️ Полезное', data:'info' }],
    [{ text:'✍️ Помощь', data:'help' }],
  ];
  /* организатор в телеграме — ссылка полезна только телеграмным */
  if (plat === 'tg' && camp.tg) rows.at(-1).push({ text:'✍️ Организатор', url:'https://t.me/' + camp.tg });
  return rows;
}

/* мои записи: signups.json (сделаны из бота или с телефона) +
   participants.json (записал организатор в админке). Вторые бот снять
   не может — это его запись, не наша; так и говорим. */
/* Что участник знает о себе, считает сервер: он один видит и записи с
   телефонов, и то, что вписал штаб, и лимиты мест. Своей копии этих
   правил у бота нет специально — две копии рано или поздно разойдутся. */
const api = async (route, payload) => {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}${route}`,
      { method:'POST', headers:{ 'Content-Type':'application/json' }, body: JSON.stringify(payload) });
    const data = await r.json().catch(() => ({}));
    return { status: r.status, ...data };
  } catch (err) { return { status: 0, ok:false, error:'offline' }; }
};
const meOf = key => api('/me', { phone: phoneOf(key) });

const seatText = seat => !seat ? ''
  : seat.cap > 0 ? (seat.taken >= seat.cap ? `мест нет (${seat.cap})`
                                           : `свободно ${seat.cap - seat.taken} из ${seat.cap}`)
                 : `идёт ${seat.taken}`;
const isFull = seat => !!seat && seat.cap > 0 && seat.taken >= seat.cap;
const OFFLINE = { text:'Записи ведёт штаб, а он сейчас не отвечает. Попробуйте позже — '
                     + 'или подойдите и запишитесь на месте.', kb:[[{ text:'‹ Меню', data:'menu' }]] };

/* Своя запись снимается, чужая — нет. Единственное место, где это
   решается: и кнопка, и обработчик нажатия смотрят сюда. */
export function markOf(name, self, org){
  return self.has(name) ? { icon:'✅ ', mine:true }
       : org.has(name)  ? { icon:'📌 ', mine:false, locked:true }
       :                  { icon:'➕ ', mine:false };
}

/* Сколько человек уже идёт. Считаем по именам: в signups.json имя
   берётся из той же карточки участника, поэтому дважды один человек не
   посчитается. Разойтись может только если штаб впишет класс тому, кто
   уже записался сам, — тогда счётчик честно покажет одного. */
/* Один и тот же мастер-класс идёт в разные дни разными группами
   («Пиклбол · ЧТ» и «Пиклбол · ПТ» — это не дубль). Под каким именем
   запись лежит в signups.json и в p.classes, решает лендинг — берём
   его функцию, а не свою копию, иначе записи с телефона и из бота
   разойдутся, и админка покажет их как ⚠ чужие. */
const keyFallback = c => c && c.day ? c.name + ' · ' + c.day : (c ? c.name : '');
const readKeyFn = cached('landing.html', html => {
  const m = html.match(/^function clsKey\([\s\S]*?\n\}/m);
  if (!m) { console.error('в лендинге нет function clsKey — считаю ключ по своей копии'); return keyFallback; }
  return new Function(m[0] + '\nreturn clsKey;')();
}, keyFallback);
export const cKey = c => readKeyFn()(c);

function classesView(camp, me, note){
  const self = new Set(me.mine || []), org = new Set(me.locked || []);
  const line = c => `${markOf(cKey(c), self, org).icon}${cKey(c)} · ${seatText(me.seats[cKey(c)])}`;
  return { text: (note ? note + '\n\n' : '') + '🎨 Мастер-классы\n\n'
             + cut(camp.classes.map(line).join('\n'))
             + '\n\n✅ — вы записаны, 📌 — записал штаб. Откройте любой, чтобы записаться.',
           kb: [...camp.classes.map((c, i) =>
                  [{ text: markOf(cKey(c), self, org).icon + cKey(c), data:'k:' + i }]), [BACK]] };
}

/* Карточка мастер-класса: всё про него и одна понятная кнопка. */
function classCard(camp, i, me, note){
  const c = camp.classes[i];
  if (!c) return classesView(camp, me);
  const k = cKey(c), seat = me.seats[k];
  const mark = markOf(k, new Set(me.mine || []), new Set(me.locked || []));
  const full = !mark.mine && !mark.locked && isFull(seat);
  const status = mark.mine ? '✅ Вы записаны'
               : mark.locked ? '📌 Вас записал штаб — снять запись может только он'
               : full ? '🚫 Мест нет. Подойдите к штабу — вдруг кто-то откажется'
               : 'Вы пока не записаны';
  const act = (mark.locked || full) ? []
            : [{ text: mark.mine ? '✖️ Отменить запись' : '✅ Записаться', data:'c:' + i }];
  return { text: (note ? note + '\n\n' : '') + '🎨 ' + classText(c)
             + (c.day ? `\n📆 ${c.day}` : '')
             + `\n👥 ${seatText(seat)}\n${status}`,
           kb: [...(act.length ? [act] : []),
                [{ text:'‹ Мастер-классы', data:'cls' }, BACK]] };
}

const askPhone = { text:'Чтобы показать вашу комнату и записи, нужно вас узнать.\n'
                      + 'Нажмите кнопку ниже — мессенджер сам пришлёт номер, привязанный к аккаунту.',
                   contact:true };

export async function render(key, a){
  const camp = readCamp();
  if (!camp) return { text:'Данные лагеря сейчас недоступны, попробуйте через минуту.' };
  const plat = key.split(':')[0];

  if (a === 'days') {
    const t = todayIndex(camp);
    return { text: t < 0 ? 'Какой день?' : 'Какой день? Сегодня отмечено точкой.',
             kb: [...chunk(camp.days.map((d, i) =>
               ({ text:`${i === t ? '• ' : ''}${d.date} ${d.dow}`, data:'d:' + i })), 3), [BACK]] };
  }

  if (a.startsWith('d:'))
    return { text: dayText(camp, +a.slice(2)),
             kb: [[{ text:'‹ Дни', data:'days' }, BACK]] };

  if (a === 'ann')    return { text: annText(camp),    kb: [[BACK]] };
  if (a === 'info')   return { text: infoText(camp),   kb: [[BACK]] };
  if (a === 'themes') return { text: themesText(camp), kb: [[{ text:'📅 Расписание', data:'days' }, BACK]] };
  if (a === 'help')   return { text: helpText(camp),
    kb: [plat === 'tg' && camp.tg ? [{ text:'✍️ Написать организатору', url:'https://t.me/' + camp.tg }, BACK]
                                  : [BACK]] };

  /* отвязка: подтверждение кнопкой, чтобы не слетело случайным нажатием */
  if (a === 'forget') return personOf(key)
    ? { text:'Отвязать ваш номер? Комната и записи останутся у штаба, но бот перестанет вас узнавать.',
        kb: [[{ text:'Да, отвязать', data:'forget!' }, { text:'Отмена', data:'menu' }]] }
    : { text:'Вы и так не привязаны.', kb: [[BACK]] };
  if (a === 'forget!') {
    const u = L.users[key];
    if (u) { noteIds(u.phone, key.startsWith('tg:') ? { tgId:null, tg:null } : { maxId:null });
             delete L.users[key]; saveLinks(); flushIds(); }
    return { text:'Отвязали. Захотите вернуться — просто пришлите номер снова.',
             kb: menuKb(plat, camp) };
  }

  if (a === 'room') {
    const p = personOf(key);
    if (!p) return askPhone;
    const me = await meOf(key);
    return { text: roomText(readPeople(), p, readRooms(),
                            me.ok ? [...(me.mine || []), ...(me.locked || [])] : []), kb: [[BACK]] };
  }

  if (a === 'cls' || a.startsWith('k:')) {
    if (!personOf(key)) return askPhone;
    const me = await meOf(key);
    if (!me.ok) return OFFLINE;
    return a === 'cls' ? classesView(camp, me) : classCard(camp, +a.slice(2), me);
  }

  if (a.startsWith('c:')) {
    const p = personOf(key);
    if (!p) return askPhone;
    const i = +a.slice(2), c = camp.classes[i];
    if (!c) return { text:'Такого мастер-класса нет.', kb:[[{ text:'‹ Мастер-классы', data:'cls' }]] };
    const k = cKey(c);
    const was = await meOf(key);
    if (!was.ok) return OFFLINE;
    if ((was.locked || []).includes(k))
      return classCard(camp, i, was, 'Вас записал штаб — снять запись может только он.');
    const off = (was.mine || []).includes(k);
    /* решает сервер: у него все записи и лимиты, а не только наши */
    const res = await api('/signup', { phone: phoneOf(key), cls: k, off });
    if (res.status === 200)
      return classCard(camp, i, res, off ? `Запись на «${k}» снята.` : `Записали на «${k}». Ждём вас!`);
    if (res.error === 'full')
      return classCard(camp, i, await meOf(key), 'Пока вы смотрели, места закончились.');
    if (res.status === 404)
      return { text:'Штаб не нашёл вас в списке участников — подойдите к нему.', kb:[[BACK]] };
    return OFFLINE;
  }

  const me = personOf(key) ? await meOf(key) : null;
  return { text: cardText(camp, key, me && me.ok ? [...(me.mine || []), ...(me.locked || [])] : []),
           kb: menuKb(plat, camp) };
}

const chunk = (arr, n) => arr.reduce((a, x, i) => (i % n ? a.at(-1).push(x) : a.push([x]), a), []);

/* ── 6. Мессенджеры ───────────────────────────────────────────
   Адаптер знает четыре вещи: опросить, отправить, ответить на
   кнопку (правкой того же сообщения), попросить контакт. */
const qs = o => '?' + new URLSearchParams(Object.entries(o).filter(([, v]) => v != null)).toString();

const tg = {
  plat:'tg', token:TG_TOKEN,
  api: (m, body) => fetch(`https://api.telegram.org/bot${TG_TOKEN}/${m}`,
        { method:'POST', headers:{ 'Content-Type':'application/json' }, body: JSON.stringify(body) })
        .then(r => r.json()),
  kb: rows => rows && { inline_keyboard: rows.map(r => r.map(b =>
        b.url ? { text:b.text, url:b.url } : { text:b.text, callback_data:b.data })) },
  contactKb: { keyboard:[[{ text:'📱 Поделиться номером', request_contact:true }]],
               resize_keyboard:true, one_time_keyboard:true },
  send(to, v){
    return tg.api('sendMessage', { chat_id:to, text:v.text,
      reply_markup: v.contact ? tg.contactKb : (tg.kb(v.kb) || { remove_keyboard:true }) });
  },
  async reply(ev, v){
    await tg.api('answerCallbackQuery', { callback_query_id: ev.cbId });
    if (v.contact) return tg.send(ev.chat, v);          // клавиатуру запроса правкой не поставить
    return tg.api('editMessageText', { chat_id:ev.chat, message_id:ev.msg,
                                       text:v.text, reply_markup: tg.kb(v.kb) });
  },
  event(u){
    /* только личка: в группе chat.id — это чат, и «моя комната»
       с фамилиями соседей уехала бы всем участникам группы */
    const c = u.callback_query;
    if (c) return c.message.chat.type !== 'private' ? null
      : { plat:'tg', user:c.from.id, chat:c.message.chat.id, nick:c.from.username || '',
          msg:c.message.message_id, cbId:c.id, data:c.data };
    const m = u.message;
    if (!m || m.chat.type !== 'private') return null;
    /* контактом можно поделиться и чужим — берём только свой */
    const phone = m.contact && m.contact.user_id === m.from.id ? m.contact.phone_number : '';
    return { plat:'tg', user:m.from.id, chat:m.chat.id, text:m.text || '',
             nick:m.from.username || '', phone };
  },
  async poll(on){
    let off = 0;
    for (;;) {
      try {
        const r = await tg.api('getUpdates',
          { offset:off, timeout:30, allowed_updates:['message','callback_query'] });
        if (!r.ok) throw new Error(r.description || 'getUpdates');
        for (const u of r.result) { off = u.update_id + 1; await on(tg, tg.event(u)); }
      } catch (err) { console.error('tg:', err.message); await sleep(3000); }
    }
  },
};

const MAX_URL = 'https://platform-api2.max.ru';
const max = {
  plat:'max', token:MAX_TOKEN,
  api: (m, p = {}, body) => fetch(MAX_URL + m + qs(p),
        { method: body ? 'POST' : 'GET',
          headers:{ Authorization: MAX_TOKEN, 'Content-Type':'application/json' },
          body: body && JSON.stringify(body) }).then(r => r.json()),
  kb: rows => rows && [{ type:'inline_keyboard', payload:{ buttons: rows.map(r => r.map(b =>
        b.url ? { type:'link', text:b.text, url:b.url } : { type:'callback', text:b.text, payload:b.data })) } }],
  body: v => ({ text: v.text, attachments: v.contact
        ? [{ type:'inline_keyboard', payload:{ buttons:[[{ type:'request_contact', text:'📱 Поделиться номером' }]] } }]
        : (max.kb(v.kb) || []) }),
  send: (to, v) => max.api('/messages', { user_id:to }, max.body(v)),
  /* у MAX ответ на кнопку и есть правка сообщения — один вызов */
  reply: (ev, v) => max.api('/answers', { callback_id: ev.cbId }, { message: max.body(v) }),
  event(u){
    if (u.update_type === 'message_callback')
      return { plat:'max', user:u.callback.user.user_id, chat:u.callback.user.user_id,
               cbId:u.callback.callback_id, data:u.callback.payload };
    if (u.update_type === 'bot_stopped')
      return { plat:'max', user:u.user.user_id, stop:true };
    if (u.update_type === 'bot_started')
      return { plat:'max', user:u.user.user_id, chat:u.user.user_id, text:'/start' };
    if (u.update_type !== 'message_created') return null;
    const m = u.message;
    if (m.recipient && m.recipient.chat_type !== 'dialog') return null;   // только личка
    const at = (m.body.attachments || []).find(a => a.type === 'contact');
    /* hash в payload проставляется, когда номер действительно принадлежит аккаунту */
    const vcf = at && at.payload.hash ? String(at.payload.vcf_info || '') : '';
    return { plat:'max', user:m.sender.user_id, chat:m.sender.user_id,
             text:m.body.text || '', phone:(vcf.match(/TEL[^:]*:\s*([+\d()\s-]+)/) || [,''])[1] };
  },
  async poll(on){
    let marker;
    for (;;) {
      try {
        const r = await max.api('/updates', { marker, timeout:30, limit:100 });
        if (!Array.isArray(r.updates)) throw new Error(r.message || r.code || 'updates');
        for (const u of r.updates) await on(max, max.event(u));
        marker = r.marker ?? marker;
      } catch (err) { console.error('max:', err.message); await sleep(3000); }
    }
  },
};

/* ── 7. Обработчик ────────────────────────────────────────────
   Пришло из сети: доверяем только цифрам телефона и своему же
   списку экранов. Всё остальное — в меню. */
async function onEvent(bot, ev){
  if (!ev) return;
  const key = `${bot.plat}:${ev.user}`;
  const say = v => ev.cbId ? bot.reply(ev, v) : bot.send(ev.chat, v);

  if (ev.stop) return unlink(key);          // удалил бота — вычёркиваем, чтобы не слать в пустоту

  if (ev.phone) {
    const p = findPerson(readPeople(), ev.phone);
    if (!p) return say({ text:'Не нашли этот номер в списке участников. '
                             + 'Напишите организатору — добавим, и всё заработает.' });
    L.users[key] = { chat: ev.chat, phone: tail(ev.phone), name: p.name };
    saveLinks();
    noteIds(tail(ev.phone), bot.plat === 'tg'
      ? { tgId: String(ev.user), tg: ev.nick || '' }
      : { maxId: String(ev.user) });
    return say(await render(key, 'menu'));
  }

  if (ev.data) return say(await render(key, ev.data));

  const text = (ev.text || '').trim();
  /* /send текст            — всем привязанным
     /send Музыка | текст    — только записанным на этот мастер-класс */
  if (text.startsWith('/send') && ADMINS.has(key)) {
    const rest = text.slice(5).trim();
    const parts = rest.split('|');
    let msg = rest, to = null, cls = '';
    if (parts.length > 1) {
      const camp = readCamp();
      const q = parts[0].trim().toLowerCase();
      /* «Пиклбол» — обе группы, «Пиклбол · ЧТ» — только четверг */
      const hit = camp ? camp.classes.filter(x =>
        x.name.toLowerCase() === q || cKey(x).toLowerCase() === q) : [];
      if (!hit.length) return say({ text:'Не нашли такой мастер-класс. Есть: '
        + (camp ? camp.classes.map(cKey).join(', ') : '—') });
      cls = hit.map(cKey).join(', ');
      msg = parts.slice(1).join('|').trim();
      to = [...new Set(hit.flatMap(x => keysForClass(cKey(x))))];
    }
    if (!msg) return say({ text:'Что разослать?\n/send текст\n/send Музыка | текст' });
    if (to && !to.length) return say({ text:`На «${cls}» ещё никто не записан через бота.` });
    const n = await broadcast('📢 ' + msg, to);
    return say({ text:`Разослано: ${n}${cls ? ` · записанным на «${cls}»` : ''}.` });
  }
  if (text === '/id')     return say({ text:`Ваш ключ: ${key}` });
  if (text === '/help')   return say({ text: helpCmds(key) });
  if (text === '/menu')   return say(await render(key, 'menu'));
  if (text === '/forget') return say(await render(key, 'forget'));
  if (text === '/stats' && ADMINS.has(key)) return say({ text: statsText() });
  /* админка signups.json не читает — единственное место, где организатор
     видит записи с телефонов и из ботов. Уберите, когда штаб научится. */
  if (text === '/list' && ADMINS.has(key)) return say({ text: signupsText(readSignups()) });
  /* номер можно и просто написать — не у всех включена отдача контакта */
  if (tail(text).length === 10 && /^[+\d()\s-]+$/.test(text))
    return onEvent(bot, { ...ev, phone:text, text:'' });

  const v = await render(key, 'menu');
  if (text && !text.startsWith('/')) v.text = 'Я отвечаю кнопками — вот всё, что есть.\n\n' + v.text;
  return say(v);
}

function unlink(key){
  const u = L.users[key];
  if (!u) return;
  noteIds(u.phone, key.startsWith('tg:') ? { tgId:null, tg:null } : { maxId:null });
  delete L.users[key];
  saveLinks();
}

function helpCmds(key){
  const base = ['Что я умею:',
    '📅 Расписание по дням — 🔴 отмечено то, что идёт прямо сейчас',
    '🏠 Ваша комната, соседи и ваши мастер-классы',
    '🎨 Мастер-классы — открыть карточку и записаться или отменить запись',
    '📢 Объявления, 🌲 тематика дней, ℹ️ памятка, ✍️ помощь',
    '',
    'Новые объявления и изменения в мастер-классах присылаю сам.',
    '',
    'Команды: /menu, /help, /forget — отвязать номер, /id'];
  if (ADMINS.has(key)) base.push('', 'Штабу: /send текст · /send Музыка | текст · /list · /stats');
  return base.join('\n');
}

/* кому уходит адресная рассылка: записались через бота или их записал штаб */
function keysForClass(k){
  /* строка записи помнит «кто» как 'p:<последние 10 цифр номера>' */
  const who = new Set(readSignups().filter(r => r.cls === k).map(r => r.who));
  return Object.keys(L.users).filter(key => {
    if (who.has('p:' + phoneOf(key))) return true;
    const p = personOf(key);
    return !!p && (p.classes || []).includes(k);
  });
}

function statsText(){
  const people = readPeople().filter(p => p.status !== 'cancelled');
  const keys = Object.keys(L.users);
  const rows = readSignups();
  return ['📊 Сейчас в базе',
    `👥 Участников: ${people.length}`,
    `🤖 В боте: tg ${keys.filter(k => k.startsWith('tg:')).length} · max ${keys.filter(k => k.startsWith('max:')).length}`,
    `🏠 Без комнаты: ${people.filter(p => !String(p.room ?? '').trim()).length}`,
    `🎨 Записей через бота и телефоны: ${rows.length} (человек: ${new Set(rows.map(r => r.who)).size})`,
  ].join('\n');
}

export function signupsText(rows){
  if (!rows.length) return 'Записей с телефонов и из ботов пока нет.';
  const by = {};
  for (const r of rows) (by[r.cls] ||= []).push(r);
  return '🎨 Записи на мастер-классы\n\n' + cut(Object.entries(by)
    .sort((a, b) => b[1].length - a[1].length)
    .map(([cls, rs]) => `${cls} — ${rs.length}\n`
      + rs.map(r => `· ${r.name}${r.room ? ' (комн. ' + r.room + ')' : ''}`).join('\n'))
    .join('\n\n'));
}

/* ── 8. Рассылки ──────────────────────────────────────────────
   Ручная — /send от админа. Автоматическая — по факту правки
   лендинга: новое объявление или изменившийся мастер-класс
   уходят в боты сами, второй раз их набирать не нужно. */
async function broadcast(text, keys){
  let n = 0;
  for (const key of keys || Object.keys(L.users)) {
    const u = L.users[key];
    const bot = key.startsWith('tg:') ? tg : max;
    if (!u || !bot.token) continue;
    try {
      const r = await bot.send(u.chat, { text: cut(text) });
      /* заблокировал бота — вычёркиваем, иначе будем стучаться в стену каждый день */
      if (r && r.ok === false && r.error_code === 403) { unlink(key); continue; }
      n++;
    }
    catch (err) { console.error('рассылка', key, err.message); }
    await sleep(120);                      // MAX: не больше 2 сообщений в секунду в диалог
  }
  return n;
}

export function newsOf(camp, seen){
  const out = [];
  for (const a of camp.announcements) {
    const k = `${a.at}|${a.title}`;
    if (!seen.ann.includes(k)) { seen.ann.push(k); out.push(`📢 ${a.title}\n${plain(a.text)}`); }
  }
  for (const c of camp.classes) {
    const h = JSON.stringify([c.txt, c.when, c.where, c.who]);
    const was = c.name in seen.cls;
    if (seen.cls[c.name] !== h) {
      seen.cls[c.name] = h;
      out.push(`🎨 ${was ? 'Изменения в мастер-классе' : 'Новый мастер-класс'}\n\n${classText(c)}`);
    }
  }
  seen.ann = seen.ann.slice(-300);
  return out;
}

function watchCamp(){
  const src = path.join(ROOT, 'landing.html');
  if (!fs.existsSync(src)) return;
  const check = async silent => {
    const camp = readCamp();
    if (!camp) return;
    const news = newsOf(camp, L);
    saveLinks();
    if (silent) return;                    // первый прогон: запомнили, но не разослали
    for (const t of news) await broadcast(t);
  };
  check(true);
  let t;
  fs.watch(src, () => { clearTimeout(t); t = setTimeout(() => check(false), 2000); });
}

/* ── 9. Проверка ──────────────────────────────────────────────
   Сеть не нужна: проверяем разбор данных и правила, а не HTTP. */
async function selftest(){
  const a = (ok, what) => { console.log((ok ? '  ok   ' : '  ПЛОХО') + '  ' + what);
                            if (!ok) process.exitCode = 1; };
  const camp = readCamp();
  a(!!camp && camp.days.length > 0,                    'CAMP разобран из landing.html');
  a(dayText(camp, 0).includes(camp.days[0].events[0].ev), 'расписание дня собирается');
  a(dayText(camp, 99) === 'Такого дня в программе нет.', 'несуществующий день не роняет бота');

  /* откуда берётся токен: файл панели главнее окружения, но выключатель
     в панели должен выключать, а не откатывать на переменную */
  a(pickToken({ on:true,  token:'из-файла' }, 'из-окружения') === 'из-файла',
                                                       'токен берётся из панели');
  a(pickToken({ on:false, token:'из-файла' }, 'из-окружения') === '',
                                                       'выключенный в панели бот не поднимется на старой переменной');
  a(pickToken({ on:true,  token:'' }, 'из-окружения') === 'из-окружения',
                                                       'пустое поле в панели — работает окружение');
  a(pickToken(undefined, 'из-окружения') === 'из-окружения' && pickToken(undefined, undefined) === '',
                                                       'без файла интеграций ничего не ломается');
  a(pickToken({ on:true, token:'  с пробелами  ' }, '') === 'с пробелами',
                                                       'пробелы по краям токена срезаются');
  /* с базой файл не участвует вовсе — иначе снятая в панели галочка
     не выключала бы бота, а старый токен из файла побеждал бы новый */
  const FILE = { telegram:{ on:true, token:'из-файла' } };
  a(tokenSource(true,  { telegram:{ on:true, token:'из-базы' } }, FILE).telegram.token === 'из-базы',
                                                       'с базой токен берётся из базы');
  a(tokenSource(true,  null, FILE).telegram === undefined,
                                                       'база не ответила — лежалый файл не подставляется');
  a(tokenSource(false, null, FILE).telegram.token === 'из-файла',
                                                       'без базы работает файл');
  a(pickToken(tokenSource(true, {}, FILE).telegram, 'из-окружения') === 'из-окружения',
                                                       'пустая база — остаётся окружение, а не файл');

  a(tail('+7 (900) 111-22-33') === tail('89001112233'), '+7 и 8 — один и тот же номер');
  a(tail('123') === '123' && tail('') === '',           'мусорный номер не притворяется телефоном');
  const people = [{ name:'Аня', phone:'+7 900 111-22-33', room:'12', status:'arrived', classes:[] },
                  { name:'Боря', phone:'89001112244', room:'12', status:'confirmed', classes:[] },
                  { name:'Витя', phone:'89001112255', room:'12', status:'cancelled', classes:[] },
                  { name:'Гена', phone:'89001112266', room:'',   status:'new', classes:[] }];
  a(findPerson(people, '8 900 111 22 33').name === 'Аня', 'участник найден по любому формату номера');
  a(findPerson(people, '89001112255') === null,           'отказавшийся не опознаётся');
  a(findPerson(people, '') === null && findPerson(people, '12') === null,
                                                          'пустой номер никого не открывает');
  const r = roomText(people, people[0], { '12':'2 этаж, направо' });
  a(r.includes('Боря') && !r.includes('Витя'),            'соседи — только по своей комнате и без отказов');
  a(r.includes('2 этаж, направо'),                        'подсказка из rooms.json попадает в карточку');
  a(roomText(people, people[0]).includes('Комната 12'),   'без rooms.json — просто номер комнаты');
  a(roomText(people, people[3]).includes('ещё не назначили'), 'без комнаты — понятный ответ');
  a(roomText(people, people[0], {}, ['Музыка','Спорт']).includes('Ваши мастер-классы: Музыка, Спорт'),
                                                          'свои записи видны там же, где комната');
  a(!roomText(people, people[0], {}, []).includes('мастер-классы'), 'без записей строка не мозолит глаза');

  const base = [{ name:'Аня', phone:'+7 900 111-22-33', tg:'', classes:[] },
                { name:'Боря', phone:'89001112244', tg:'borya', classes:[] }];
  a(applyIds(base, { '9001112233':{ tgId:'42', tg:'anya' } }) === 2,          'id и ник дописались');
  a(base[0].tgId === '42' && base[0].tg === 'anya',                           'поля попали в нужную карточку');
  a(applyIds(base, { '9001112233':{ tgId:'42', tg:'anya' } }) === 0,          'повторная привязка файл не трогает');
  a(applyIds(base, { '9001112244':{ tgId:'7', tg:'other' } }) === 1
    && base[1].tg === 'borya',                                                'ник, вписанный штабом, не перезаписывается');
  a(applyIds(base, { '9001112233':{ maxId:'99' } }) === 1 && base[0].tgId === '42',
                                                                              'MAX добавляется, телеграм остаётся');
  a(applyIds(base, { '9009999999':{ tgId:'1' } }) === 0,                      'чужой номер ничего не создаёт');
  a(!('room' in base[0]) && Object.keys(base[0]).join() === 'name,phone,tg,classes,tgId,maxId',
                                                                              'бот дописывает только свои поля');
  a(applyIds(base, { '9001112233':{ tgId:null } }) === 1 && !('tgId' in base[0]),
                                                                              'отвязка стирает id из базы');
  a(applyIds(base, { '9001112233':{ tgId:null } }) === 0,                      'стирать нечего — файл не трогаем');
  /* и то же самое на настоящем файле: заезд идёт, а штаб в это время правит список */
  const tmp = path.join(os.tmpdir(), 'camp-people-test.json');
  fs.writeFileSync(tmp, JSON.stringify([{ name:'Аня', phone:'+7 900 111-22-33', room:'12', note:'аллергия' }], null, 2));
  a(writeIds({ '9001112233':{ tgId:'42' } }, tmp) === 1,   'запись в файл прошла');
  const back = JSON.parse(fs.readFileSync(tmp, 'utf8'))[0];
  a(back.tgId === '42' && back.room === '12' && back.note === 'аллергия',
                                                          'правки штаба на месте, добавился только tgId');
  a(writeIds({ '9001112233':{ tgId:'42' } }, tmp) === 0,   'второй раз файл не переписывается');
  a(writeIds({ '9001112233':{ tgId:'7' } }, path.join(os.tmpdir(), 'нет-такого.json')) === 0,
                                                          'пропавший список не роняет бота');
  fs.rmSync(tmp, { force:true });

  /* время: 25.08.2026 — заезд 14:30, снек 21:45–23:30, отбой 00:00 */
  const at = (d, h, m) => new Date(2026, 7, d, h, m);
  const tl = timeline(camp);
  a(tl.every((x, i) => !i || tl[i - 1].start <= x.start),  'события выстроены по времени');
  const late = tl.find(x => x.ev === 'Отбой');
  a(late.start.getDate() === 26,                           'отбой в 00:00 — это уже следующие сутки');
  const n1 = nowText(camp, at(25, 16, 20));
  a(n1.includes('Сейчас: Игра на знакомство') && n1.includes('до 17:30'), 'текущее событие видно с концом');
  a(n1.includes('Ужин'),                                   'следом показано ближайшее');
  a(nowText(camp, at(25, 9, 0)).startsWith('Лагерь начнётся'), 'до заезда — когда начнётся');
  a(nowText(camp, at(25, 23, 0)).includes('завтра 00:00'), 'ночное событие подписано «завтра»');
  a(nowText(camp, at(30, 12, 0)).includes('закончился'),   'после отъезда бот не зовёт на завтрак');
  const n2 = nowText(camp, at(26, 13, 30));
  a(n2.includes('🔴 Сейчас: Обед (до 14:00)'),             'обед 13:00–14:00 попадает в «сейчас»');
  a(n2.split('· ').length === 3,                           'дальше показываем ровно два события');
  a(dayText(camp, 1, at(26, 13, 30)).includes('🔴 13:00'), 'в расписании дня видно, что идёт сейчас');
  a(!dayText(camp, 1, at(26, 3, 0)).includes('🔴'),        'ночью ничего не подсвечено');
  a(todayIndex(camp, at(27, 12, 0)) === 2 && todayIndex(camp, at(30, 12, 0)) === -1,
                                                           'сегодняшний день лагеря определяется');
  a(datesText(camp) === '25–29 августа 2026',              'даты смены собираются из дней');
  const th = themesText(camp, at(27, 12, 0));
  a(camp.days.every(d => th.includes(d.theme)) && th.includes('• 27'), 'тематика всех дней, сегодня — точкой');
  const hp = helpText(camp);
  a(hp.includes('@' + camp.tg) && hp.includes(camp.place) && hp.includes(datesText(camp))
    && !hp.includes('<'),                                  'помощь: организатор, место, даты и без html');


  const c1 = { announcements:[{ at:'2026-08-25 12:00', title:'A', text:'раз' }],
               classes:[{ name:'Музыка', txt:'', when:'', where:'', who:'' }] };
  const seen = { ann:[], cls:{} };
  a(newsOf(c1, seen).length === 2,                      'первый прогон видит всё');
  a(newsOf(c1, seen).length === 0,                      'второй раз то же самое не шлётся');
  c1.announcements.push({ at:'2026-08-25 13:00', title:'B', text:'два' });
  a(newsOf(c1, seen).length === 1,                      'новое объявление замечено');
  c1.classes[0].where = 'Беседка';
  const upd = newsOf(c1, seen);
  a(upd.length === 1 && upd[0].includes('Изменения'),   'правка мастер-класса — не «новый»');
  a(plain('<a href="x">@kim</a>&nbsp;тут') === '@kim тут', 'html из лендинга вычищен');
  a(plain('первое.<br>второе') === 'первое.\nвторое',    '<br> становится переносом, а не склейкой');
  a(!helpText(camp).includes('связь.Быстрее'),           'памятка из лендинга читается предложениями');
  a(cut('x'.repeat(5000)).length <= 3500,               'длинный текст обрезан под лимит мессенджера');

  /* роутер: незалинкованный аккаунт (в bots.json его нет) не должен
     ни увидеть чужую комнату, ни записаться — только просьбу о номере */
  const nobody = 'tg:0';
  for (const scr of ['room', 'cls', 'c:0'])
    a((await render(nobody, scr)).contact === true,     `экран «${scr}» без привязки просит номер`);
  for (const scr of ['menu', 'days', 'd:0', 'ann', 'info', 'themes', 'help'])
    a((await render(nobody, scr)).text.length > 10,     `экран «${scr}» открыт всем`);
  a((await render(nobody, 'forget')).text.includes('и так не привязаны'),
                                                        'непривязанному нечего отвязывать');
  a((await render(nobody, 'нет такого')).kb.flat().some(b => b.data === 'days'),
                                                        'неизвестная кнопка приводит в меню');
  const self = new Set(['Музыка']), org = new Set(['Музыка', 'Рукоделие']);
  a(markOf('Музыка', self, org).mine === true,          'своя запись снимается, даже если её видит и организатор');
  a(markOf('Рукоделие', self, org).locked === true,     'запись организатора бот снять не даёт');
  a(!markOf('Спорт', self, org).mine && !markOf('Спорт', self, org).locked,
                                                        'незанятый мастер-класс просто предлагается');
  a(markOf('Музыка', self, org).icon === '✅ ' && markOf('Рукоделие', self, org).icon === '📌 ',
                                                        'галочки различают свою запись и чужую');
  a(signupsText([]).includes('пока нет'),                'пустой список записей не пугает организатора');
  const st = signupsText([{ name:'Аня', room:'12', cls:'Музыка' }, { name:'Боря', room:'', cls:'Музыка' },
                          { name:'Гена', room:'3', cls:'Спорт' }]);
  a(st.indexOf('Музыка — 2') < st.indexOf('Спорт — 1'),  'популярные мастер-классы сверху');
  a(st.includes('Аня (комн. 12)') && st.includes('· Боря\n'), 'без комнаты — просто имя, без пустых скобок');
  /* ключ записи: «название · день». Один мастер-класс в четверг и в
     пятницу — две разные группы, и путать их нельзя. */
  a(cKey({ name:'Пиклбол', day:'ЧТ' }) === 'Пиклбол · ЧТ',  'ключ записи берётся из лендинга и содержит день');
  a(cKey({ name:'Слушай глубже' }) === 'Слушай глубже',     'без дня ключ — само название');
  a(cKey({ name:'Пиклбол', day:'ЧТ' }) !== cKey({ name:'Пиклбол', day:'ПТ' }),
                                                            'четверг и пятница не сливаются в одну группу');
  a(new Set(camp.classes.map(cKey)).size === camp.classes.length,
                                                            'в живом лендинге у каждой группы свой ключ');

  a(seatText({ cap:0, taken:5 }) === 'идёт 5',           'без ограничения просто считаем идущих');
  a(seatText({ cap:8, taken:3 }) === 'свободно 5 из 8',  'при лимите видно, сколько осталось');
  a(seatText({ cap:8, taken:8 }) === 'мест нет (8)' && isFull({ cap:8, taken:9 }),
                                                         'заполненная группа так и написана');
  a(!isFull({ cap:0, taken:99 }) && !isFull(undefined),  'без cap и для незнакомой группы лимита нет');
  a(seatText(undefined) === '',                          'нет данных о местах — нет и строки');

  const datas = [];
  for (const scr of ['menu', 'days', 'd:0', 'ann', 'info', 'themes', 'help', 'forget'])
    for (const b of ((await render(nobody, scr)).kb || []).flat()) if (b.data) datas.push(b.data);
  for (const scr of ['k:0', 'c:0'])
    a((await render(nobody, scr)).contact === true,     `карточка «${scr}» без привязки просит номер`);
  a(['days','ann','room','cls','themes','info','help'].every(x => datas.includes(x)),
                                                        'все разделы страницы есть в меню бота');
  a(datas.length > 6 && datas.every(d => Buffer.byteLength(d) <= 64),
                                                        'callback_data влезает в лимит Telegram');
}

/* ── 10. Запуск ───────────────────────────────────────────────── */
const RUN_DIRECT = /bots\.mjs$/.test(process.argv[1] || '');

if (process.argv.includes('--selftest')) { await selftest(); }
else if (RUN_DIRECT) {
  await resolveTokens();
  const on = [tg, max].filter(b => b.token);
  if (!on.length) {
    console.error('Нет токенов. Впишите их в панели: Доступ → Интеграции,');
    console.error('или запустите как раньше: TG_TOKEN=… MAX_TOKEN=… node bots.mjs');
    process.exit(1);
  }
  /* Прокси в панели заполнить можно, а применить — нет: node здесь
     запускается без единой зависимости, а socks5 своими руками — это
     отдельный клиент на сотню строк ради одного лагеря. Молчать об
     этом нельзя: человек впишет адрес, увидит «включён» и будет ждать,
     что бот пробьётся через блокировку. Поэтому говорим прямо. */
  if (PROXY && PROXY.on && PROXY.url) {
    console.error('Внимание: прокси в панели задан, но бот ходит напрямую —');
    console.error('поддержки socks5 здесь нет. Если Telegram недоступен, запускайте');
    console.error('бота там, где он доступен, или заверните весь процесс во внешний прокси.');
  }
  watchCamp();
  on.forEach(b => b.poll(onEvent));
  /* Ctrl+C на середине заезда не должен съесть накопленные id */
  process.on('SIGINT', () => { flushIds(); process.exit(0); });
  console.log(`\n  Боты: ${on.map(b => b.plat).join(', ')}`);
  console.log(`  Записи уходят на http://127.0.0.1:${PORT}/signup (server.mjs должен работать)`);
  console.log(`  Привязано участников: ${Object.keys(L.users).length}`);
  console.log(`  Рассылка админом: /send текст  ·  админы: ${[...ADMINS].join(', ') || 'не заданы'}\n`);
}
