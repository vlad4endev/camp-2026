/* Единая база лагеря: Supabase + локальное зеркало.

   Зачем зеркало, если есть база: в лагере нет интернета. Это не сбой,
   а штатный режим — на нём построен весь проект. Поэтому:

     ЧТЕНИЕ  всегда идёт из зеркала (те же participants.json и
             signups.json рядом). Мгновенно и работает без сети.
     ЗАПИСЬ  идёт в Supabase; не дошла — ложится в outbox.json и
             досылается, когда связь вернётся.

   Источник правды — база. Зеркало её только повторяет, поэтому
   расходиться им негде: единственное, что живёт локально дольше
   секунды, — это очередь неотправленного.

   БЕЗ ПЕРЕМЕННЫХ ОКРУЖЕНИЯ ЭТОТ МОДУЛЬ ВЫКЛЮЧЕН. configured() отдаёт
   false, server.mjs работает ровно как раньше — на файлах. Так переезд
   можно включать по одной машине, а не всем сразу.

     SUPABASE_URL=https://xxxx.supabase.co
     SUPABASE_SERVICE_KEY=…        (service_role: RLS его не касается)

   service_role — ключ от всей базы. Он живёт только здесь, на машинах
   server.mjs и bots.mjs, и никогда не уезжает в браузер. Админка и
   стойка ходят под своим входом с ключом anon. */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const URL_   = process.env.SUPABASE_URL || '';
const KEY    = process.env.SUPABASE_SERVICE_KEY || '';
const TIMEOUT = Number(process.env.SUPABASE_TIMEOUT || 4000);

export const configured = () => !!(URL_ && KEY);

/* ── 1. КЛИЕНТ POSTGREST ──────────────────────────────────────────
   supabase-js сюда не нужен: у проекта ноль зависимостей, а REST —
   это обычный HTTP с двумя заголовками. */

async function call(pathname, { method = 'GET', body, prefer } = {}){
  if (!configured()) throw new Error('Supabase не настроен');
  const res = await fetch(URL_.replace(/\/+$/, '') + '/rest/v1/' + pathname, {
    method,
    headers: {
      apikey: KEY,
      Authorization: 'Bearer ' + KEY,
      'Content-Type': 'application/json',
      ...(prefer ? { Prefer: prefer } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

export const select = (table, query = '') => call(table + (query ? '?' + query : ''));
export const rpc    = (fn, args = {}) => call('rpc/' + fn, { method:'POST', body: args });

/* upsert по первичному ключу: тем же вызовом создаём и обновляем */
export const upsert = (table, rows) =>
  call(table, { method:'POST', body: Array.isArray(rows) ? rows : [rows],
                prefer:'resolution=merge-duplicates,return=minimal' });

export const patch = (table, query, fields) =>
  call(table + '?' + query, { method:'PATCH', body: fields, prefer:'return=minimal' });

export const remove = (table, query) =>
  call(table + '?' + query, { method:'DELETE', prefer:'return=minimal' });

/* ── 2. ЗЕРКАЛО ───────────────────────────────────────────────────
   Имена файлов те же, что были: PUBLIC_FILES, selftest и режим «без
   Supabase» продолжают работать, ничего про переезд не зная. */

const ROOT   = process.env.CAMP_ROOT || process.cwd();
const F      = n => path.join(ROOT, n);
const PEOPLE = F('participants.json');
const SIGN   = F('signups.json');
const CAMP   = F('camp.json');
const OUTBOX = F('outbox.json');

/* .tmp + rename, как и во всём проекте: читатель не должен увидеть
   файл на середине записи */
function writeAtomic(file, text){
  fs.writeFileSync(file + '.tmp', text);
  fs.renameSync(file + '.tmp', file);
}

function readJson(file, fallback){
  try {
    const v = JSON.parse(fs.readFileSync(file, 'utf8'));
    return v ?? fallback;
  } catch { return fallback }
}

let state = { online:false, at:0, err:'' };
export const status = () => ({ ...state, queued: readOutbox().length,
                               configured: configured() });

/* ── 3. ФОРМА ЗАПИСИ ──────────────────────────────────────────────
   База хранит змеиный регистр (tg_id), JSON лагеря — верблюжий (tgId).
   Переводим здесь, в одном месте: остальной код про базу не знает.
   Взносы приезжают отдельной таблицей и склеиваются обратно в массив,
   потому что и админка, и стойка, и лендинг ждут p.payments. */

export const toJson = (row, pays) => {
  const p = {
    id: row.id, name: row.name || '', role: row.role || 'guest',
    status: row.status || 'new', phone: row.phone || '', tg: row.tg || '',
    room: row.room || '', classes: row.classes || [],
    fee: Number(row.fee) || 0, note: row.note || '',
    payments: (pays || []).map(y => ({ id: y.id, at: y.at || '',
                                       sum: Number(y.sum) || 0, note: y.note || '' })),
  };
  if (row.arrived_at) p.arrivedAt = row.arrived_at;
  if (row.tg_id)      p.tgId      = row.tg_id;
  if (row.max_id)     p.maxId     = row.max_id;
  return p;
};

/* Обратный перевод: только те поля, что нам дали. Никогда не
   подставляем значения по умолчанию — иначе patch с одним полем
   затёр бы всё остальное. */
const FIELDS = { name:'name', role:'role', status:'status', phone:'phone',
                 tg:'tg', room:'room', classes:'classes', fee:'fee',
                 note:'note', arrivedAt:'arrived_at', tgId:'tg_id', maxId:'max_id' };

export function toRow(obj){
  const out = {};
  for (const [k, col] of Object.entries(FIELDS))
    if (k in obj) out[col] = obj[k] === undefined ? null : obj[k];
  return out;
}

/* ── 4. ЧТЕНИЕ: всегда из зеркала ─────────────────────────────────*/

export const people  = () => { const a = readJson(PEOPLE, []); return Array.isArray(a) ? a : [] };
export const signups = () => { const a = readJson(SIGN,   []); return Array.isArray(a) ? a : [] };
export const camp    = () => readJson(CAMP, null);      // null — зеркала ещё нет

/* ── 5. ОБНОВЛЕНИЕ ЗЕРКАЛА ────────────────────────────────────────
   Три запроса вместо одного: PostgREST умеет вложенные выборки, но
   отдельные списки проще читать в логах, когда что-то не сходится. */

export async function pull(){
  try {
    const [rows, pays, sign, content] = await Promise.all([
      select('participants', 'select=*&order=name'),
      select('payments',     'select=*&order=created_at'),
      select('signups',      'select=who,name,room,cls,at&order=at'),
      select('camp_content', 'select=doc,version&id=eq.1'),
    ]);

    const byId = new Map();
    for (const y of pays){
      const list = byId.get(y.participant_id);
      if (list) list.push(y); else byId.set(y.participant_id, [y]);
    }

    writeAtomic(PEOPLE, JSON.stringify(rows.map(r => toJson(r, byId.get(r.id))), null, 2));
    writeAtomic(SIGN,   JSON.stringify(sign.map(r => ({ who:r.who, name:r.name,
                          room:r.room || '', cls:r.cls, at:r.at })), null, 2));

    const c = content && content[0];
    if (c) writeAtomic(CAMP, JSON.stringify({ v: c.version, camp: c.doc }, null, 2));

    state = { online:true, at: Date.now(), err:'' };
    return true;
  } catch (err) {
    state = { ...state, online:false, err: err.message };
    return false;
  }
}

/* ── 6. ОЧЕРЕДЬ НЕОТПРАВЛЕННОГО ───────────────────────────────────
   Каждая операция несёт id, придуманный на месте. Поэтому повторная
   отправка безопасна: запись на мастер-класс упирается в unique
   (who, cls), взнос — в primary key. Идемпотентность здесь не
   аккуратность кода, а свойство схемы.

   Порядок сохраняем: заезд, потом взнос — иначе взнос прилетит
   человеку, которого на стойке ещё не создали. */

const readOutbox = () => { const a = readJson(OUTBOX, []); return Array.isArray(a) ? a : [] };
const MAX_QUEUE  = 2000;

export function enqueue(op){
  const q = readOutbox();
  if (q.length >= MAX_QUEUE) throw new Error('очередь переполнена');
  q.push({ ...op, at: op.at || new Date().toISOString() });
  writeAtomic(OUTBOX, JSON.stringify(q, null, 2));
  return op;
}

/* Что делать с каждой операцией. Возврат: true — отправлено (убираем
   из очереди), строка — отказ по существу (тоже убираем, но громко:
   мест уже нет, и второй раз пробовать нечего). Исключение — связь,
   оставляем в очереди до следующего раза. */
async function send(op){
  switch (op.op){
    case 'signup': {
      const r = await rpc('claim_seat', { p_who: op.who, p_name: op.name,
                            p_room: op.room || '', p_cls: op.cls, p_off: !!op.off });
      return r && r.ok ? true : ('не прошло: ' + ((r && r.error) || 'отказ'));
    }
    case 'person':                                  // создание или правка
      await upsert('participants', { id: op.id, ...toRow(op.fields) });
      return true;
    case 'payment':
      await upsert('payments', { id: op.pay_id, participant_id: op.id,
                                 at: op.at_day || '', sum: op.sum, note: op.note || '' });
      return true;
    case 'payment_del':
      await remove('payments', 'id=eq.' + encodeURIComponent(op.pay_id));
      return true;
    default:
      return 'неизвестная операция: ' + op.op;
  }
}

/* Досылаем по одной и по порядку. Первая же сетевая ошибка
   останавливает проход: иначе операции применились бы вразнобой. */
export async function flush(log = () => {}){
  let q = readOutbox();
  if (!q.length) return { sent:0, failed:0 };
  let sent = 0; const failed = [];
  while (q.length){
    const op = q[0];
    let verdict;
    try { verdict = await send(op); }
    catch (err) {                                   // связь: ждём следующего раза
      state = { ...state, online:false, err: err.message };
      break;
    }
    q = q.slice(1);
    writeAtomic(OUTBOX, JSON.stringify(q, null, 2));
    if (verdict === true) sent++;
    else { failed.push({ op, why: verdict }); log(`очередь: ${op.op} — ${verdict}`); }
  }
  return { sent, failed: failed.length, rejected: failed };
}

/* ── 7. ЗАПИСЬ ────────────────────────────────────────────────────
   Сначала пробуем в базу. Не вышло по сети — в очередь, и сразу же
   правим зеркало, чтобы телефон увидел свою запись, а стойка —
   принятые деньги. Обещание при этом честное: place в очереди не
   гарантирует места, и claim_seat при досылке может отказать. */

export async function signup(rec){
  const args = { p_who: rec.who, p_name: rec.name, p_room: rec.room || '',
                 p_cls: rec.cls, p_off: !!rec.off };
  try {
    const r = await rpc('claim_seat', args);
    state = { online:true, at: Date.now(), err:'' };
    if (r && r.ok) await pull();                    // зеркало сразу актуально
    return r;
  } catch (err) {
    state = { ...state, online:false, err: err.message };
    enqueue({ op:'signup', who:rec.who, name:rec.name, room:rec.room || '',
              cls:rec.cls, off:!!rec.off });
    mirrorSignup(rec);
    return { ok:true, queued:true, seats:null };
  }
}

/* Оптимистичная правка зеркала: ровно та же чистая функция логики,
   что и раньше, только применяется к локальной копии. */
function mirrorSignup(rec){
  const list = signups().filter(r => !(r.who === rec.who && r.cls === rec.cls));
  if (!rec.off) list.push({ who:rec.who, name:rec.name, room:rec.room || '',
                            cls:rec.cls, at:new Date().toISOString() });
  writeAtomic(SIGN, JSON.stringify(list, null, 2));
}

/* Правка участника: id придумывает клиент, поэтому создание и
   изменение — одна операция. Зеркало правим поверх текущей копии,
   меняя только присланные поля: чужая правка не затирается. */
export async function savePerson(id, fields){
  try {
    await upsert('participants', { id, ...toRow(fields) });
    state = { online:true, at: Date.now(), err:'' };
    await pull();
    return { ok:true };
  } catch (err) {
    state = { ...state, online:false, err: err.message };
    enqueue({ op:'person', id, fields });
    mirrorPerson(id, fields);
    return { ok:true, queued:true };
  }
}

export async function addPayment(id, pay){
  const pay_id = pay.id || randomUUID();
  try {
    await upsert('payments', { id: pay_id, participant_id: id, at: pay.at || '',
                               sum: pay.sum, note: pay.note || '' });
    state = { online:true, at: Date.now(), err:'' };
    await pull();
    return { ok:true, id: pay_id };
  } catch (err) {
    state = { ...state, online:false, err: err.message };
    enqueue({ op:'payment', id, pay_id, at_day: pay.at || '',
              sum: pay.sum, note: pay.note || '' });
    mirrorPerson(id, null, p => { p.payments = [...(p.payments || []),
      { id: pay_id, at: pay.at || '', sum: pay.sum, note: pay.note || '' }] });
    return { ok:true, id: pay_id, queued:true };
  }
}

export async function delPayment(id, pay_id){
  try {
    await remove('payments', 'id=eq.' + encodeURIComponent(pay_id));
    state = { online:true, at: Date.now(), err:'' };
    await pull();
    return { ok:true };
  } catch (err) {
    state = { ...state, online:false, err: err.message };
    enqueue({ op:'payment_del', id, pay_id });
    mirrorPerson(id, null, p => {
      p.payments = (p.payments || []).filter(y => y.id !== pay_id);
    });
    return { ok:true, queued:true };
  }
}

function mirrorPerson(id, fields, fn){
  const list = people();
  let p = list.find(x => x && x.id === id);
  if (!p){ p = { id, name:'', role:'guest', status:'new', phone:'', tg:'',
                 room:'', classes:[], fee:0, note:'', payments:[] };
           list.push(p); }
  if (fields) Object.assign(p, fields);
  if (fn) fn(p);
  writeAtomic(PEOPLE, JSON.stringify(list, null, 2));
}

/* ── 8. ЦИКЛЫ ─────────────────────────────────────────────────────
   Тянем зеркало и досылаем очередь. Интервал по умолчанию 15 секунд:
   лендинг и так спрашивает сервер раз в 30, чаще смысла нет. */

export function start({ every = 15000, log = console.log } = {}){
  if (!configured()){
    log('Supabase не настроен — работаем на файлах, как раньше');
    return () => {};
  }
  let stopped = false, timer;
  const tick = async () => {
    if (stopped) return;
    const ok = await pull();
    if (ok){
      const r = await flush(log);
      if (r.sent)   log(`очередь: отправлено — ${r.sent}`);
      if (r.failed) log(`очередь: отклонено базой — ${r.failed}`);
    }
    timer = setTimeout(tick, every);
  };
  tick();
  return () => { stopped = true; clearTimeout(timer); };
}

/* ── 9. Проверка ──────────────────────────────────────────────────
   node db.mjs --selftest

   Сеть здесь не трогаем: проверяем то, что ломается тихо и дорого —
   перевод полей (patch не должен затирать соседние) и механику
   очереди. Остальное видно сразу, по ошибке в консоли. */

if (import.meta.filename === process.argv[1] && process.argv.includes('--selftest')){
  let bad = 0;
  const a = (cond, what) => { console.log(`  ${cond ? 'ok  ' : 'НЕ ОК'}  ${what}`); if (!cond) bad++; };
  const eq = (x, y) => JSON.stringify(x) === JSON.stringify(y);

  console.log('\n  db.mjs\n');

  /* Главное свойство: в базу уезжают ТОЛЬКО присланные поля. Иначе
     «отметить заезд» обнулило бы взнос и стёрло комнату. */
  a(eq(toRow({ status:'arrived' }), { status:'arrived' }),
                                        'patch несёт только своё поле');
  a(eq(toRow({ arrivedAt:'2026-08-26 14:30' }), { arrived_at:'2026-08-26 14:30' }),
                                        'верблюжий регистр переводится в змеиный');
  a(eq(toRow({ arrivedAt:null }), { arrived_at:null }),
                                        'null стирает время заезда');
  a(eq(toRow({ arrivedAt:undefined }), { arrived_at:null }),
                                        'undefined тоже стирает, а не молчит');
  a(eq(toRow({}), {}),                  'пустая правка не сочиняет полей');
  a(eq(toRow({ name:'Аня', выдумка:1 }), { name:'Аня' }),
                                        'незнакомое поле в базу не уезжает');

  /* Обратно: строка базы + её взносы → та форма, которую ждут админка,
     стойка и лендинг. */
  const p = toJson({ id:'anya', name:'Аня', fee:'8000', role:'guest',
                     status:'arrived', arrived_at:'2026-08-26 14:30', tg_id:'777' },
                   [{ id:'y1', at:'2026-08-26', sum:'3000', note:'' },
                    { id:'y2', at:'2026-08-27', sum:2000, note:'остаток' }]);
  a(p.fee === 8000 && typeof p.fee === 'number',  'взнос приходит числом, а не строкой');
  a(p.payments.length === 2 && p.payments[0].sum === 3000,
                                                 'взносы склеены обратно в массив');
  a(p.payments.reduce((s,y) => s + y.sum, 0) === 5000,
                                                 'сумма взносов считается как раньше');
  a(p.arrivedAt === '2026-08-26 14:30' && p.tgId === '777',
                                                 'заезд и id бота на месте');
  a(!('arrived_at' in p) && !('tg_id' in p),     'змеиных имён в JSON лагеря не остаётся');
  const empty = toJson({ id:'x', name:'' }, null);
  a(eq(empty.payments, []) && empty.classes.length === 0,
                                                 'без взносов и групп — пустые массивы, не null');
  a(!('arrivedAt' in empty),                     'кто не заехал, тот без времени заезда');

  /* Очередь: порядок и целость файла. Пишем в свою папку, чтобы не
     задеть рабочий outbox.json. */
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'camp-db-'));
  const box = path.join(tmp, 'outbox.json');
  const q = [];
  const push = op => { q.push({ ...op, at:'t' });
                       fs.writeFileSync(box, JSON.stringify(q, null, 2)); };
  push({ op:'person',  id:'anya', fields:{ status:'arrived' } });
  push({ op:'payment', id:'anya', pay_id:'y1', sum:3000 });
  const saved = JSON.parse(fs.readFileSync(box, 'utf8'));
  a(saved.length === 2 && saved[0].op === 'person',
                                        'порядок сохранён: заезд раньше взноса');
  a(saved.every(o => o.at),             'у каждой операции есть время');
  a(saved[1].pay_id === 'y1',           'id взноса придуман на месте — повтор безопасен');
  fs.rmSync(tmp, { recursive:true, force:true });

  console.log(bad ? `\n  ${bad} не сошлось\n` : '\n  Всё сошлось\n');
  process.exit(bad ? 1 : 0);
}
