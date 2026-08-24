/* Разовый перенос: JSON-файлы лагеря → Supabase.

       SUPABASE_URL=… SUPABASE_SERVICE_KEY=… node supabase/import.mjs
       …                                    node supabase/import.mjs --dry

   Идемпотентный: upsert по первичному ключу. Прогнать дважды не страшно,
   второй раз просто перезапишет теми же значениями. Что уже есть в базе
   и чего нет в файлах — не удаляется: снести лишнее руками безопаснее,
   чем однажды снести нужное.

   ЧЕГО ЭТОТ СКРИПТ НЕ ДЕЛАЕТ: не переносит пароли из users.json. Хэши
   там свои (PBKDF2, 120000 итераций), Supabase Auth их не примет, и это
   правильно — пароли не переезжают, люди заводятся заново. Скрипт лишь
   напечатает, кого надо создать в Auth и какую роль ему выдать. */

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { upsert, configured } from '../db.mjs';

const ROOT = process.env.CAMP_ROOT || process.cwd();
const DRY  = process.argv.includes('--dry');
const F    = n => path.join(ROOT, n);

const read = (n, fallback) => {
  try { return JSON.parse(fs.readFileSync(F(n), 'utf8')) ?? fallback }
  catch { return fallback }
};

const say = (...a) => console.log(...a);

/* ── Блок CAMP из лендинга ────────────────────────────────────────
   Тем же приёмом, что server.mjs и админка: литерал вырезаем
   регуляркой и исполняем как выражение. Файл свой, доверять можно. */
function campFromLanding(){
  const src = fs.readFileSync(F('landing.html'), 'utf8');
  const m = src.match(/const CAMP\s*=\s*\{[\s\S]*?\n\};/);
  if (!m) throw new Error('в landing.html не нашёлся блок const CAMP');
  const body = m[0].slice(m[0].indexOf('{'), -1);
  return new Function('return (' + body + ')')();
}

/* ── Участники и взносы ───────────────────────────────────────────
   Взносы уезжают в свою таблицу. id придумываем здесь, если его не
   было: в старом формате взнос — просто объект в массиве. */
function splitPeople(list){
  const rows = [], pays = [];
  const seen = new Set();
  for (const p of list){
    if (!p || typeof p !== 'object') continue;
    let id = String(p.id || '').trim();
    if (!id || seen.has(id)) id = randomUUID().slice(0, 8);
    seen.add(id);

    rows.push({
      id,
      name:    String(p.name || ''),
      role:    ['guest','team'].includes(p.role) ? p.role : 'guest',
      status:  ['new','confirmed','arrived','left','cancelled'].includes(p.status)
               ? p.status : (p.arrived ? 'arrived' : 'new'),
      phone:   String(p.phone || ''),
      tg:      String(p.tg || ''),
      tg_id:   p.tgId  ? String(p.tgId)  : null,
      max_id:  p.maxId ? String(p.maxId) : null,
      room:    String(p.room || ''),
      classes: Array.isArray(p.classes) ? p.classes.map(String) : [],
      fee:     Number(p.fee) || 0,
      note:    String(p.note || ''),
      arrived_at: p.arrivedAt || null,
    });

    // старый формат: paid числом вместо массива взносов
    let list2 = Array.isArray(p.payments) ? p.payments : [];
    if (!list2.length && p.paid){
      const sum = p.paid === true ? (Number(p.fee) || 0) : (Number(p.paid) || 0);
      if (sum) list2 = [{ at:'', sum, note:'перенесено из старого формата' }];
    }
    for (const y of list2){
      const sum = Number(y && y.sum) || 0;
      if (!sum) continue;
      pays.push({ id: y.id || randomUUID(), participant_id: id,
                  at: String((y && y.at) || ''), sum, note: String((y && y.note) || '') });
    }
  }
  return { rows, pays };
}

/* ── Поехали ──────────────────────────────────────────────────────*/

if (!configured() && !DRY){
  console.error('Нужны SUPABASE_URL и SUPABASE_SERVICE_KEY. Проверить без записи: --dry');
  process.exit(1);
}

const people  = read('participants.json', []);
const signs   = read('signups.json', []);
const links   = read('bots.json', {});
const rooms   = read('rooms.json', {});
const integ   = read('integrations.json', null);
const users   = read('users.json', []);
const camp    = campFromLanding();

const { rows, pays } = splitPeople(Array.isArray(people) ? people : []);

const signRows = (Array.isArray(signs) ? signs : [])
  .filter(r => r && r.who && r.cls)
  .map(r => ({ who: String(r.who), name: String(r.name || ''),
               room: String(r.room || ''), cls: String(r.cls),
               at: r.at || new Date().toISOString() }));

const linkRows = Object.entries(links || {}).map(([account, v]) => ({
  account,
  participant_id: (v && v.id)    ? String(v.id) : null,
  phone_key:      (v && v.phone) ? String(v.phone).replace(/\D/g,'').slice(-10) : null,
}));

const roomRows = Object.entries(rooms || {}).map(([room, hint]) =>
  ({ room: String(room), hint: String(hint || '') }));

say(`Участники      ${rows.length}`);
say(`Взносы         ${pays.length}  (на сумму ${pays.reduce((a,y)=>a+y.sum,0)})`);
say(`Записи на МК   ${signRows.length}`);
say(`Привязки ботов ${linkRows.length}`);
say(`Комнаты        ${roomRows.length}`);
say(`Блок CAMP      дней ${(camp.days||[]).length}, групп ${(camp.classes||[]).length}`);
say(`Токены ботов   ${integ ? 'есть' : 'нет файла'}`);

if (DRY){
  say('\n--dry: ничего не записано.');
  process.exit(0);
}

/* Порядок обязателен: взносы и записи ссылаются на участников. */
if (rows.length)     { await upsert('participants', rows);     say('✓ участники'); }
if (pays.length)     { await upsert('payments', pays);         say('✓ взносы'); }
if (signRows.length) { await upsert('signups', signRows);      say('✓ записи на мастер-классы'); }
if (linkRows.length) { await upsert('bot_links', linkRows);    say('✓ привязки ботов'); }
if (roomRows.length) { await upsert('rooms', roomRows);        say('✓ комнаты'); }

await upsert('camp_content', { id: 1, doc: camp });             say('✓ содержимое лагеря');
if (integ) { await upsert('integrations', { id: 1, doc: integ }); say('✓ токены ботов'); }

/* Пароли не переезжают — печатаем список, кого создать руками. */
if (Array.isArray(users) && users.length){
  say('\nОсталось вручную: создать этих людей в Supabase Auth');
  say('(Authentication → Users → Add user), а потом выдать роль.');
  say('Первым заводите admin: без активного главного база не даст');
  say('добавить остальных, а управлять доступом может только он.\n');
  const byRole = [...users].sort((a, b) =>
    (a.role === 'admin' ? 0 : 1) - (b.role === 'admin' ? 0 : 1));
  for (const u of byRole)
    say(`  insert into staff (user_id, email, name, role) values ` +
        `('<uuid из Auth>', '<e-mail>', ` +
        `'${String(u.name || u.login).replace(/'/g, "''")}', ` +
        `'${['admin','lead','desk','content'].includes(u.role) ? u.role : 'lead'}');`);
  say('\nПароли из users.json не переносятся: их хэши Supabase Auth не примет.');
  say('Дальше остальных добавляет сам штаб — раздел «Пользователи».');
}

say('\nГотово.');
