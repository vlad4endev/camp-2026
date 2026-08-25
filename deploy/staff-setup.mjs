/* Учётки штаба и стойки: приводит вход к двум адресам.
 *
 *   admin@offline.club → роль admin → штаб (/admin/)
 *   resep@offline.club → роль desk  → стойка (/reseption/)
 *
 * Запускается НА СЕРВЕРЕ (ключи живут в /etc/camp.env и наружу не выходят):
 *
 *   node /srv/camp-src/deploy/staff-setup.mjs              — только привести адреса
 *   CAMP_PASS='пароль' node .../staff-setup.mjs            — и поставить обоим один пароль
 *
 * Идемпотентен: старые адреса @offline.camp переименовывает, а не плодит
 * дубли; повторный запуск ничего не ломает. Роль пишется upsert-ом в staff —
 * без строки там вход есть, а доступа нет (RLS).
 */
import { readFileSync } from 'node:fs';

const STAFF = [
  { email: 'admin@offline.club', name: 'Организатор', role: 'admin',
    aka: ['admin@offline.camp'] },
  { email: 'resep@offline.club', name: 'Ресепшн', role: 'desk',
    aka: ['resep@offline.camp'] },
];

/* /etc/camp.env — тот же файл, которым живёт camp.service. Разбор нарочно
   простой: KEY=VALUE построчно, без экранирования — так файл и написан. */
export function parseEnv(text){
  const out = {};
  for (const line of String(text).split('\n')) {
    const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
    if (m) out[m[1]] = m[2];
  }
  return out;
}

/* Кого из списка GoTrue считать «этой» учёткой: сперва точный адрес,
   потом старые имена — так переименование не создаёт второго человека. */
export function pick(users, want){
  const by = email => users.find(u => (u.email || '').toLowerCase() === email);
  return by(want.email) || want.aka.map(by).find(Boolean) || null;
}

function init(){
  const env = { ...parseEnv(readFileSync('/etc/camp.env', 'utf8')), ...process.env };
  const URL = env.SUPABASE_URL, KEY = env.SUPABASE_SERVICE_KEY;
  if (!URL || !KEY) throw new Error('в /etc/camp.env нет SUPABASE_URL или SUPABASE_SERVICE_KEY');
  const PASS = process.env.CAMP_PASS || '';

  const H = { apikey: KEY, Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json' };
  const call = async (method, path, body) => {
    const r = await fetch(URL + path, { method, headers: H, body: body && JSON.stringify(body) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(method + ' ' + path + ' → ' + r.status + ' ' + JSON.stringify(d));
    return d;
  };
  return { URL, KEY, ANON: env.SUPABASE_ANON_KEY || '', PASS, H, call };
}

/* --check: ничего не меняет. Показывает учётки как их видит GoTrue и
   пробует войти каждой с паролем из CAMP_PASS тем же путём, каким входит
   браузер, — чтобы отличить «пароль не тот» от «сломано что-то ещё». */
async function check(){
  const { URL, ANON, PASS, call } = init();
  const got = await call('GET', '/auth/v1/admin/users?per_page=1000');
  const users = got.users || got;

  console.log('== учётки в GoTrue:');
  for (const u of users)
    console.log(`  ${u.email}  aud=${JSON.stringify(u.aud)}  confirmed=${!!u.email_confirmed_at}` +
      `  banned=${u.banned_until || '-'}  создан=${(u.created_at || '').slice(0, 10)}`);

  console.log('== строки staff:');
  const rows = await call('GET', '/rest/v1/staff?select=email,role,off');
  for (const s of rows) console.log(`  ${s.email}  роль=${s.role}  off=${s.off}`);

  console.log('== пробный вход (как из браузера, ключом anon):');
  if (!PASS) { console.log('  CAMP_PASS не задан — вход не пробую'); return; }
  for (const w of STAFF) {
    const r = await fetch(URL + '/auth/v1/token?grant_type=password', {
      method: 'POST',
      headers: { apikey: ANON, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: w.email, password: PASS }),
    });
    const d = await r.json().catch(() => ({}));
    console.log(`  ${w.email}: ` + (r.ok ? 'ВХОД ЕСТЬ'
      : r.status + ' ' + (d.error_description || d.msg || d.error || JSON.stringify(d))));
  }
}

async function main(){
  const { URL, PASS, H, call } = init();

  const got = await call('GET', '/auth/v1/admin/users?per_page=1000');
  const users = got.users || got;

  for (const w of STAFF) {
    let u = pick(users, w);
    if (u) {
      const patch = {};
      if ((u.email || '').toLowerCase() !== w.email) patch.email = w.email;
      if (PASS) patch.password = PASS;
      if (Object.keys(patch).length) {
        patch.email_confirm = true;
        await call('PUT', '/auth/v1/admin/users/' + u.id, patch);
        console.log(`[staff] ${w.email}: обновлено (${Object.keys(patch).join(', ')})`);
      } else console.log(`[staff] ${w.email}: уже на месте`);
    } else {
      if (!PASS) throw new Error(w.email + ' ещё нет — для создания задайте CAMP_PASS');
      u = await call('POST', '/auth/v1/admin/users',
        { email: w.email, password: PASS, email_confirm: true });
      console.log(`[staff] ${w.email}: создан`);
    }

    /* Роль. merge-duplicates: есть строка — правим, нет — заводим. */
    await fetch(URL + '/rest/v1/staff?on_conflict=user_id', {
      method: 'POST',
      headers: { ...H, Prefer: 'resolution=merge-duplicates' },
      body: JSON.stringify({ user_id: u.id, email: w.email, name: w.name, role: w.role, off: false }),
    }).then(async r => {
      if (!r.ok) throw new Error('staff upsert → ' + r.status + ' ' + await r.text());
    });
    console.log(`[staff] ${w.email}: роль ${w.role}`);
  }
  console.log('[staff] готово: admin@offline.club → штаб, resep@offline.club → стойка');
}

/* node staff-setup.mjs --selftest — проверка разбора без сети и сервера. */
if (process.argv.includes('--check')) {
  check().catch(err => { console.error('[staff] ' + err.message); process.exit(1); });
} else if (process.argv.includes('--selftest')) {
  const a = (ok, t) => { if (!ok) { console.error('ПЛОХО: ' + t); process.exit(1); } };
  const e = parseEnv('SUPABASE_URL=https://x\n# коммент\nПУСТО\nSUPABASE_SERVICE_KEY=k=v\n');
  a(e.SUPABASE_URL === 'https://x', 'env: простая пара');
  a(e.SUPABASE_SERVICE_KEY === 'k=v', 'env: = внутри значения');
  const us = [{ id: 1, email: 'admin@offline.camp' }, { id: 2, email: 'resep@offline.club' }];
  a(pick(us, STAFF[0]).id === 1, 'находит по старому адресу');
  a(pick(us, STAFF[1]).id === 2, 'находит по новому адресу');
  a(pick(us, { email: 'нет@нигде', aka: [] }) === null, 'чужих не выдумывает');
  console.log('selftest: ок');
} else {
  main().catch(err => { console.error('[staff] ' + err.message); process.exit(1); });
}
