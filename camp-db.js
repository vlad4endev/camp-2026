/* Единая база лагеря — сторона браузера. Один файл на две панели:
   admin.html и reception.html подключают его тегом script.

   Почему общий файл, хотя весь проект — самодостаточные страницы:
   модель участника в них и так продублирована нарочно (и сверяется в
   selftest), но клиент базы дублировать нельзя — разъехавшиеся версии
   двух панелей означают тихо разное поведение на одних и тех же данных.

   ЧТО ЗДЕСЬ ЕСТЬ
     вход       — Supabase Auth, e-mail и пароль. users.json с его
                  PBKDF2 больше не нужен: пароли теперь дело Supabase.
     данные     — participants, payments, signups, camp_content поверх
                  PostgREST. Ключ anon, права раздаёт RLS по таблице
                  staff, поэтому чужой человек с тем же ключом не
                  увидит ничего.
     офлайн     — не дотянулись до Supabase, но локальный сервер рядом:
                  операция уходит ему в POST /queue, он дошлёт её сам.
                  В лагере без интернета это единственный рабочий путь.

   ЧЕГО ЗДЕСЬ НЕТ: ключа service_role. Он даёт доступ в обход RLS и
   живёт только на сервере. В браузер он не попадает никогда. */

(function (global) {
'use strict';

const LS = 'camp-supabase-config';      // {url, anon}
const SS = 'camp-supabase-session';     // токены: сессия вкладки, не дольше

const cfg = { url:'', anon:'' };
let sess = null;

/* ── 1. НАСТРОЙКА ─────────────────────────────────────────────────
   Адрес проекта и ключ anon вводят один раз в админке. Ключ anon не
   секрет (он и задуман публичным), но в репозиторий его класть нечего:
   он показывает, какой это проект. Поэтому localStorage, а не файл. */

function load(){
  try { Object.assign(cfg, JSON.parse(localStorage.getItem(LS) || '{}')); } catch (_) {}
  try { sess = JSON.parse(sessionStorage.getItem(SS) || 'null'); } catch (_) {}
  if (global.CAMP_SB) Object.assign(cfg, global.CAMP_SB);   // можно задать и в HTML
}
load();

const configured = () => !!(cfg.url && cfg.anon);

function configure(next){
  Object.assign(cfg, { url: String(next.url || '').replace(/\/+$/, ''),
                       anon: String(next.anon || '').trim() });
  localStorage.setItem(LS, JSON.stringify(cfg));
}

function forget(){
  localStorage.removeItem(LS);
  sessionStorage.removeItem(SS);
  cfg.url = cfg.anon = ''; sess = null;
}

/* ── 2. ВХОД ──────────────────────────────────────────────────────*/

async function auth(path, body){
  const r = await fetch(cfg.url + '/auth/v1/' + path, {
    method:'POST',
    headers:{ apikey: cfg.anon, 'Content-Type':'application/json' },
    body: JSON.stringify(body),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error_description || data.msg || data.message || ('вход не удался (' + r.status + ')'));
  return data;
}

function keep(data){
  sess = { access: data.access_token, refresh: data.refresh_token,
           uid:   (data.user && data.user.id)    || (sess && sess.uid)   || '',
           email: (data.user && data.user.email) || (sess && sess.email) || '',
           at: Date.now() };
  sessionStorage.setItem(SS, JSON.stringify(sess));
  return sess;
}

async function signIn(email, password){
  if (!configured()) throw new Error('база не настроена');
  keep(await auth('token?grant_type=password', { email, password }));
  const me = await staffMe();
  if (!me){                                  // в Auth есть, в штабе нет
    signOut();
    throw new Error('этот аккаунт не в списке персонала — обратитесь к главному');
  }
  sess.role = me.role; sess.name = me.name;
  sessionStorage.setItem(SS, JSON.stringify(sess));
  return sess;
}

function signOut(){ sess = null; sessionStorage.removeItem(SS); }
const session = () => sess;

/* Токен живёт час. Молча продлеваем по refresh — организатор не должен
   терять экран посреди заезда из-за истёкшего токена. */
async function refresh(){
  if (!sess || !sess.refresh) return false;
  try {
    const keepRole = { role: sess.role, name: sess.name };
    keep(await auth('token?grant_type=refresh_token', { refresh_token: sess.refresh }));
    Object.assign(sess, keepRole);
    sessionStorage.setItem(SS, JSON.stringify(sess));
    return true;
  } catch (_) { signOut(); return false; }
}

/* ── 3. ЗАПРОСЫ К ДАННЫМ ──────────────────────────────────────────*/

let online = true;
const isOnline = () => online;

async function rest(path, { method = 'GET', body, prefer, retry = true } = {}){
  if (!configured()) throw new Error('база не настроена');
  if (!sess) throw new Error('нужен вход');
  let r;
  try {
    r = await fetch(cfg.url + '/rest/v1/' + path, {
      method,
      headers: {
        apikey: cfg.anon,
        Authorization: 'Bearer ' + sess.access,
        'Content-Type': 'application/json',
        ...(prefer ? { Prefer: prefer } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (err) {                            // сети нет вовсе
    online = false;
    const e = new Error('нет связи с базой'); e.offline = true; throw e;
  }
  online = true;
  if (r.status === 401 && retry && await refresh())
    return rest(path, { method, body, prefer, retry:false });
  const text = await r.text();
  if (!r.ok) throw new Error(`База ответила ${r.status}: ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}

const select = (t, q) => rest(t + (q ? '?' + q : ''));
const rpc    = (fn, args) => rest('rpc/' + fn, { method:'POST', body: args || {} });
const upsert = (t, rows) => rest(t, { method:'POST',
  body: Array.isArray(rows) ? rows : [rows],
  prefer:'resolution=merge-duplicates,return=minimal' });
const del    = (t, q) => rest(t + '?' + q, { method:'DELETE', prefer:'return=minimal' });

/* ── 4. ОФЛАЙН: через локальный сервер ────────────────────────────
   Панель открыта с того же адреса, что сервер, поэтому путь
   относительный. Сервер либо дотянется до базы сам, либо положит
   операцию в очередь. queued:true в ответе значит «принято, но ещё
   не в базе» — панель обязана это показать, а не делать вид, что всё
   сохранено. */

async function viaServer(op){
  const r = await fetch('/queue', {
    method:'POST', headers:{ 'Content-Type':'application/json' },
    body: JSON.stringify(op),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || !data.ok)
    throw new Error(data.error === 'no_db' ? 'сервер не подключён к базе'
                                          : (data.error || 'сервер не принял'));
  return data;
}

/* Один приём на все правки: пробуем базу, при обрыве — сервер.
   Ошибку по существу (нет прав, битые данные) НЕ прячем в очередь:
   она не пройдёт и со второго раза, а тихая очередь скрыла бы её. */
async function write(direct, op){
  try { return await direct(); }
  catch (err) {
    if (!err.offline) throw err;
    try { return await viaServer(op); }
    catch (e2) { throw new Error('нет связи ни с базой, ни с сервером: ' + e2.message) }
  }
}

/* ── 5. ШТАБ ──────────────────────────────────────────────────────*/

/* Роль спрашиваем строго по своему uid. Политика staff_read даёт штабу
   видеть ВЕСЬ список — значит limit=1 без фильтра вернул бы чужую
   строку и чужую роль. На правах экономить нельзя. */
async function staffMe(){
  if (!sess || !sess.uid) return null;
  const rows = await select('staff',
    'select=name,role,off&user_id=eq.' + encodeURIComponent(sess.uid));
  const me = rows && rows[0];
  return me && !me.off ? me : null;
}
const staff = () => select('staff', 'select=user_id,name,role,off&order=name');

/* ── 6. УЧАСТНИКИ ─────────────────────────────────────────────────
   Наружу отдаём ту же форму, что лежала в participants.json: массив
   с payments внутри. Панели про две таблицы не знают. */

const CAMEL = { arrived_at:'arrivedAt', tg_id:'tgId', max_id:'maxId' };
const SNAKE = { arrivedAt:'arrived_at', tgId:'tg_id', maxId:'max_id' };
const OWN   = ['name','role','status','phone','tg','room','classes','fee','note'];

function toJson(row, pays){
  const p = { id: row.id, payments: (pays || []).map(y => ({
                id: y.id, at: y.at || '', sum: Number(y.sum) || 0, note: y.note || '' })) };
  for (const k of OWN)
    p[k] = k === 'classes' ? (row.classes || [])
         : k === 'fee'     ? (Number(row.fee) || 0)
                           : (row[k] ?? (k === 'role' ? 'guest' : k === 'status' ? 'new' : ''));
  for (const [col, key] of Object.entries(CAMEL)) if (row[col]) p[key] = row[col];
  return p;
}

/* Только присланные поля: правка одного поля не должна затирать
   соседние. Это то же свойство, что и в db.mjs на сервере. */
function toRow(fields){
  const out = {};
  for (const k of Object.keys(fields)){
    if (OWN.includes(k)) out[k] = fields[k];
    else if (SNAKE[k])   out[SNAKE[k]] = fields[k] === undefined ? null : fields[k];
  }
  return out;
}

async function people(){
  const [rows, pays] = await Promise.all([
    select('participants', 'select=*&order=name'),
    select('payments', 'select=*&order=created_at'),
  ]);
  const by = new Map();
  for (const y of pays){
    const l = by.get(y.participant_id);
    if (l) l.push(y); else by.set(y.participant_id, [y]);
  }
  return rows.map(r => toJson(r, by.get(r.id)));
}

const savePerson = (id, fields) =>
  write(() => upsert('participants', { id, ...toRow(fields) }),
        { op:'person', id, fields });

const addPayment = (id, pay) => {
  const payId = pay.id || (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random());
  return write(() => upsert('payments', { id: payId, participant_id: id,
                    at: pay.at || '', sum: pay.sum, note: pay.note || '' }),
               { op:'payment', id, pay_id: payId, at: pay.at || '',
                 sum: pay.sum, note: pay.note || '' })
    .then(r => ({ ...r, id: payId }));
};

const delPayment = (id, payId) =>
  write(() => del('payments', 'id=eq.' + encodeURIComponent(payId)),
        { op:'payment_del', id, pay_id: payId });

const delPerson = id => del('participants', 'id=eq.' + encodeURIComponent(id));

/* ── 7. ЗАПИСИ НА МАСТЕР-КЛАССЫ ───────────────────────────────────*/

const signups = () => select('signups', 'select=who,name,room,cls,at&order=at');
const seats   = () => rpc('seats');
/* Штаб вписывает и снимает руками — через ту же функцию с проверкой
   лимита, что и телефоны. Иначе штаб мог бы посадить 13-го на 12 мест
   мимо всякой проверки. */
const claimSeat = (who, name, room, cls, off) =>
  write(() => rpc('claim_seat', { p_who:who, p_name:name, p_room:room || '',
                                  p_cls:cls, p_off: !!off }),
        { op:'signup', who, name, room: room || '', cls, off: !!off });

/* ── 8. СОДЕРЖИМОЕ ЛАГЕРЯ ─────────────────────────────────────────
   Тот же блок CAMP. Версию считает база (триггер), поэтому обратно
   читаем её, а не выдумываем свою. */

async function camp(){
  const rows = await select('camp_content', 'select=doc,version&id=eq.1');
  const r = rows && rows[0];
  return r ? { camp: r.doc, v: r.version } : null;
}
const saveCamp = doc =>
  rest('camp_content', { method:'POST', body:[{ id:1, doc }],
    prefer:'resolution=merge-duplicates,return=representation' })
  .then(rows => (rows && rows[0]) || null);

/* ── 9. ТОКЕНЫ БОТОВ ──────────────────────────────────────────────
   Политика пускает сюда только главного: вожатому токен бота не нужен,
   а утёкший токен — это чужой бот от имени лагеря. */

async function integrations(){
  const rows = await select('integrations', 'select=doc&id=eq.1');
  return (rows && rows[0] && rows[0].doc) || {};
}
const saveIntegrations = doc => upsert('integrations', { id:1, doc });

/* ── 10. СОСТОЯНИЕ СВЯЗИ ──────────────────────────────────────────
   Панель должна показывать это в шапке: «в базе» или «в очереди».
   Молчаливая работа в офлайне — способ потерять деньги на стойке. */

async function serverStatus(){
  try {
    const r = await fetch('/dbstatus', { cache:'no-store' });
    return r.ok ? await r.json() : null;
  } catch (_) { return null }
}

global.CampDB = {
  configure, configured, forget, config: () => ({ ...cfg }),
  signIn, signOut, session, isOnline, serverStatus,
  staff, staffMe,
  people, savePerson, addPayment, delPayment, delPerson,
  signups, seats, claimSeat,
  camp, saveCamp,
  integrations, saveIntegrations,
  toJson, toRow,
};

})(window);
