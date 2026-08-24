/* Завести или сменить доступ к панелям — прямо на сервере.
       node deploy/mkuser.mjs admin            (роль admin по умолчанию)
       node deploy/mkuser.mjs anna desk "Аня"
       node deploy/mkuser.mjs admin --check    (проверить пароль, ничего не менять)
       node deploy/mkuser.mjs --list
       node deploy/mkuser.mjs --selftest

   Зачем отдельная команда, если есть панель: панель НАМЕРЕННО не даёт
   завести доступ самому себе — «завести себе доступ прямо здесь нельзя».
   На публичном адресе кнопка «стать главным» была бы захватом панели тем,
   кто открыл её первым. Поэтому первый пользователь появляется здесь, где
   нужен доступ к серверу, а дальше остальных заводит панель.

   Хэш считается ровно так же, как в admin.html: PBKDF2-SHA256, 120 000
   итераций, 256 бит, соль — 16 случайных байт в hex, и в PBKDF2 она идёт
   КАК СТРОКА (браузер делает TextEncoder().encode(salt), а не разбирает
   hex). Совпадение проверяется в --selftest на вектор, снятый с реального
   crypto.subtle: разойдись параметры — панель не примет пароль, и понять
   это было бы неоткуда.

   users.json тот же для штаба и ресепшена. Пароль не печатается и не
   попадает ни в историю оболочки, ни в argv. */

import fs      from 'node:fs';
import path    from 'node:path';
import readline from 'node:readline';
import { pbkdf2Sync, randomBytes, timingSafeEqual } from 'node:crypto';

const ROOT = path.resolve(import.meta.dirname, '..');
const FILE = path.join(ROOT, 'users.json');
const ITER = 120000;
const ROLES = ['admin', 'content', 'lead', 'desk'];

const hashPass = (pass, salt) =>
  pbkdf2Sync(pass, salt, ITER, 32, 'sha256').toString('hex');

const newSalt = () => randomBytes(16).toString('hex');

const pad = n => String(n).padStart(2, '0');
const nowLocal = () => { const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} `
       + `${pad(d.getHours())}:${pad(d.getMinutes())}`; };

/* Те же правила, что в панели: логин набирают на телефоне, где раскладка
   чужая, поэтому только латиница. */
const loginClean = s => String(s || '').trim().toLowerCase()
  .replace(/[^a-z0-9._-]/g, '').replace(/^[._-]+/, '').slice(0, 32);

function readUsers(){
  try {
    const a = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return Array.isArray(a) ? a : [];
  } catch { return [] }
}

/* .tmp + rename: панель не должна прочитать файл на середине записи.
   Владельца берём у папки — скрипт запускают под root, а сервер работает
   под camp, и забытый chown выглядел бы как «пароль не подходит». */
function writeUsers(list){
  fs.writeFileSync(FILE + '.tmp', JSON.stringify(list, null, 2));
  fs.renameSync(FILE + '.tmp', FILE);
  try {
    const st = fs.statSync(ROOT);
    fs.chownSync(FILE, st.uid, st.gid);
    fs.chmodSync(FILE, 0o640);
  } catch (err) { console.error('  (владельца сменить не удалось: ' + err.message + ')'); }
}

/* Ввод без эха. readline для этого не годится: он перерисовывает строку и
   печатает ровно то, что мы прячем, а второй вызов на том же stdin
   повисает. Поэтому читаем байты сами, выключив эхо терминала.

   stdinRest нужен из-за трубы: `printf 'a\nb\n' | node ...` приносит оба
   пароля одним куском, и без остатка второй запрос ждал бы ввода,
   которого уже не будет. */
let stdinRest = '';

const applyBs = t => { let o = '';
  for (const c of t) o = (c === '\u007f' || c === '\b') ? o.slice(0, -1) : o + c;
  return o; };

function takeLine(){
  const i = stdinRest.search(/[\r\n]/);
  if (i < 0) return null;
  const line = stdinRest.slice(0, i);
  stdinRest = stdinRest.slice(i + 1).replace(/^\n/, '');       // \r\n
  return applyBs(line);
}

function askHidden(prompt){
  const ready = takeLine();                       // уже пришло вместе с прошлым
  if (ready !== null){ process.stdout.write(prompt + '\n'); return Promise.resolve(ready); }

  return new Promise((res, rej) => {
    process.stdout.write(prompt);
    const inp = process.stdin;
    const finish = fn => { inp.off('data', onData);
                           if (inp.isTTY) inp.setRawMode(false);
                           inp.pause(); process.stdout.write('\n'); fn(); };
    const onData = d => {
      stdinRest += d.toString('utf8');
      if (stdinRest.includes('\u0003')) return finish(() => rej(new Error('отменено')));
      const line = takeLine();
      if (line !== null) finish(() => res(line));
    };
    if (inp.isTTY) inp.setRawMode(true);
    inp.resume();
    inp.on('data', onData);
  });
}

function selftest(){
  const a = (ok, what) => { console.log((ok ? '  ok   ' : '  ПЛОХО') + '  ' + what);
                            if (!ok) process.exitCode = 1; };
  /* Вектор снят с настоящего crypto.subtle в браузере на тех же
     параметрах, что в admin.html. Если эта строка перестанет совпадать —
     хэши разошлись с панелью, и пароль в ней не сработает. */
  a(hashPass('test123', 'abcdef0123456789') ===
    'e16b6253f327c5546876d33f19c1809b5ab276b14efdc6eb63a49d6ef14f8932',
                                                'хэш совпадает с панелью (вектор crypto.subtle)');
  a(hashPass('x', 's').length === 64,           'длина хэша 256 бит в hex');
  a(hashPass('x', 's') !== hashPass('x', 't'),  'соль меняет хэш');
  a(hashPass('x', 's') !== hashPass('y', 's'),  'пароль меняет хэш');
  a(newSalt().length === 32 && newSalt() !== newSalt(), 'соль 16 байт и каждый раз своя');
  a(loginClean(' Ан-Na_1! ') === 'na_1',        'логин чистится как в панели');
  a(loginClean('---') === '' && loginClean('') === '', 'пустой логин остаётся пустым');
  a(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(nowLocal()), 'формат времени как в панели');
  a(applyBs('парол\u007fль') === 'пароль',      'backspace стирает знак, а не попадает в пароль');
  stdinRest = 'один\nдва\n';
  a(takeLine() === 'один' && takeLine() === 'два' && takeLine() === null,
                                                'два пароля из одного куска разбираются по строкам');
  stdinRest = 'crlf\r\nx';
  a(takeLine() === 'crlf' && stdinRest === 'x', 'перевод строки Windows не оставляет мусора');
  stdinRest = '';
}

/* ── разбор аргументов ──────────────────────────────────────── */
const args = process.argv.slice(2);

if (args.includes('--selftest')) { selftest(); process.exit(); }

if (args.includes('--list')) {
  const us = readUsers();
  if (!us.length) console.log('users.json пуст или отсутствует — заведите первого.');
  else for (const u of us)
    console.log(`  ${u.login.padEnd(16)} ${String(u.role).padEnd(8)} ` +
                `${u.off ? 'отключён' : 'активен '}  ${u.name || ''}`);
  process.exit();
}

const login = loginClean(args[0]);
if (!login) {
  console.error('Как звать пользователя? node deploy/mkuser.mjs <логин> [роль] ["Имя"]');
  console.error('Роли: ' + ROLES.join(', ') + '. Список: --list');
  process.exit(1);
}

const users = readUsers();
const idx   = users.findIndex(u => u.login === login);

if (args.includes('--check')) {
  if (idx < 0) { console.error(`Нет такого логина: ${login}`); process.exit(1); }
  const pass = await askHidden('Пароль: ');
  const u = users[idx];
  const got = Buffer.from(hashPass(pass, u.salt), 'hex');
  const want = Buffer.from(u.hash, 'hex');
  const ok = got.length === want.length && timingSafeEqual(got, want);
  console.log(ok ? 'Пароль верный.' : 'Пароль НЕ подходит.');
  process.exit(ok ? 0 : 1);
}

const role = ROLES.includes(args[1]) ? args[1] : 'admin';
const name = args[2] || login;

const p1 = await askHidden(`Пароль для ${login} (роль ${role}): `);
if (p1.length < 6) { console.error('Слишком короткий пароль — нужно хотя бы 6 знаков.'); process.exit(1); }
const p2 = await askHidden('Повторите: ');
if (p1 !== p2) { console.error('Пароли не совпали — ничего не изменено.'); process.exit(1); }

const salt = newSalt();
const rec  = { login, name, role, salt, hash: hashPass(p1, salt), off:false, at: nowLocal() };

if (idx >= 0) { users[idx] = { ...users[idx], ...rec }; }
else users.push(rec);

writeUsers(users);
console.log(`${idx >= 0 ? 'Пароль обновлён' : 'Пользователь заведён'}: ${login} (${role}).`);
console.log(`Всего в users.json: ${users.length}.`);
