/* Вход на стороне сервера: КТО пришёл решает сервер, а не порт.
 *
 * ЗАЧЕМ ЭТОТ ФАЙЛ ПОЯВИЛСЯ
 *
 * Раньше роль определялась портом: 8001 — штаб, 8002 — стойка, и снаружи
 * на них вели два location в nginx под двумя разными паролями. Схема была
 * честная (порт из интернета не подделать), но у неё есть следствие,
 * которое нельзя обойти: auth_basic срабатывает ДО того, как отдан первый
 * байт. Значит роль выбирается раньше, чем загрузится любая страница, —
 * и «единая страница входа, которая определяет роль» при таком порядке
 * невозможна в принципе. Пароль сам БЫЛ выбором роли.
 *
 * Поэтому вход переезжает сюда. Порядок становится обратным: сначала
 * человек говорит, кто он (Supabase Auth), потом сервер узнаёт его роль
 * (таблица staff) и только после этого решает, что ему отдавать.
 *
 * КАК УСТРОЕНО
 *   1. enter.html входит через Supabase и получает access-токен.
 *   2. Токен уходит на POST /session. Сервер проверяет его У SUPABASE
 *      (подпись мы не разбираем — за это отвечает тот, кто её ставил) и
 *      читает роль из staff под service_role.
 *   3. Сервер ставит свою куку: uid, роль, срок и подпись HMAC.
 *   4. Дальше каждый запрос приносит куку сам — включая обычный переход
 *      по ссылке на admin.html, которому заголовок не приложишь. Именно
 *      поэтому кука, а не Authorization.
 *
 * ЧЕГО ЗДЕСЬ НЕТ
 *   Хранилища сессий. Кука самодостаточна: в ней лежит ровно то, что
 *   сервер сам подписал, и проверка — это пересчёт подписи. Ни файла, ни
 *   таблицы, ни чистки просроченного.
 *
 *   Паролей. Их держит Supabase Auth, и этот файл их не видит никогда.
 *
 * ГРАНИЦА ДОВЕРИЯ: подпись покрывает uid, роль и срок. Подделать куку
 * без секрета нельзя, а секрет не покидает сервер. Но роль в куке — это
 * снимок на момент входа: отозвали доступ — кука доживёт до срока. Поэтому
 * срок короткий (смена), а необратимое (кто в списке персонала, кто платил)
 * всё равно проверяет база своими политиками RLS, а не эта кука.
 */

import { createHmac, createHash, timingSafeEqual, pbkdf2Sync } from 'node:crypto';

export const COOKIE = 'camp';

/* Смена, а не месяц: кука — это «человек за ноутбуком сейчас». Ушёл на
   заезд, вернулся к обеду — вход ещё жив; уехал домой — уже нет. */
export const TTL = 12 * 3600;

/* Роли из таблицы staff. Список закрытый: строка из базы, которой здесь
   нет, не станет ролью «на всякий случай» — она станет отказом. */
export const ROLES = new Set(['admin', 'lead', 'desk', 'content']);

/* Секрет отдельной переменной не требует: service_role и так секрет, и
   если он утёк, подделка куки — уже не самая большая беда. Хэшируем, а не
   берём как есть, чтобы подпись не была производной ключа базы напрямую.
   Ключ сменили — сессии разом стали недействительны, и это правильно. */
export const secretFrom = serviceKey =>
  serviceKey ? createHash('sha256').update('camp-session\0' + serviceKey).digest() : null;

const b64 = buf => Buffer.from(buf).toString('base64url');
const mac = (data, secret) => createHmac('sha256', secret).update(data).digest();

/* ── 1. КУКА ──────────────────────────────────────────────────────*/

/* Формат: <payload>.<подпись>, где payload — base64url от «uid|role|exp».
   Разделитель «|» безопасен: uid — это UUID, роль — из ROLES, exp — число,
   ни в одном из трёх «|» не встречается. */
export function sign(uid, role, secret, now = Date.now(), ttl = TTL){
  if (!secret) throw new Error('нет секрета для подписи');
  if (!uid || !ROLES.has(role)) throw new Error('нечего подписывать');
  const exp = Math.floor(now / 1000) + ttl;
  const payload = b64(`${uid}|${role}|${exp}`);
  return payload + '.' + b64(mac(payload, secret));
}

/* Возвращает {uid, role, exp} или null. Ни одна причина отказа наружу не
   уходит: «подпись не сошлась» и «срок вышел» для вызывающего одно и то
   же — доверять этой куке нельзя. */
export function parse(token, secret, now = Date.now()){
  if (!token || !secret || typeof token !== 'string') return null;
  const dot = token.indexOf('.');
  if (dot < 1) return null;
  const payload = token.slice(0, dot), got = token.slice(dot + 1);

  /* Сравнение постоянного времени: обычное === на строках выходит на
     первом несовпавшем байте и тем самым подсказывает, сколько байт
     подписи уже угадано. */
  let a, b;
  try { a = Buffer.from(got, 'base64url'); } catch (_) { return null }
  b = mac(payload, secret);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  let text;
  try { text = Buffer.from(payload, 'base64url').toString('utf8'); } catch (_) { return null }
  const [uid, role, exp] = text.split('|');
  if (!uid || !ROLES.has(role)) return null;
  if (!(Number(exp) > Math.floor(now / 1000))) return null;      // NaN тоже сюда
  return { uid, role, exp: Number(exp) };
}

/* Разбор заголовка Cookie. Своё, а не библиотека: нужен ровно один ключ,
   и правило простое — первое вхождение, дальше не смотрим. */
export function fromHeader(header, name = COOKIE){
  for (const part of String(header || '').split(';')){
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return '';
}

/* Кто пришёл. Единственная точка, которой пользуется сервер. */
export const who = (req, secret, now = Date.now()) =>
  parse(fromHeader(req && req.headers && req.headers.cookie), secret, now);

/* Secure ставим только на https: на ноутбуке панель открывается по
   http://localhost, и Secure-кука там не сохранилась бы вовсе. */
export const setCookie = (token, { secure = false, ttl = TTL } = {}) =>
  `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${ttl}` +
  (secure ? '; Secure' : '');

export const clearCookie = ({ secure = false } = {}) =>
  `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0` + (secure ? '; Secure' : '');

/* ── 2. ПРОВЕРКА ТОКЕНА У SUPABASE ────────────────────────────────
   Подпись JWT сами не разбираем намеренно: для этого нужен публичный
   ключ проекта, его ротация и разбор JWKS — три новых способа ошибиться
   там, где ошибка стоит весь штаб. Спрашиваем у того, кто эту подпись
   ставил. Один сетевой запрос на вход, не на запрос: дальше живёт кука. */

export async function verify(access, { url, anon, timeout = 4000, fetchImpl = fetch } = {}){
  if (!url || !anon) throw new Error('Supabase не настроен');
  if (!access || typeof access !== 'string' || access.length > 4096)
    throw new Error('нет токена');

  const stop = AbortSignal.timeout(timeout);
  let r;
  try {
    r = await fetchImpl(url.replace(/\/+$/, '') + '/auth/v1/user', {
      headers: { apikey: anon, Authorization: 'Bearer ' + access },
      signal: stop,
    });
  } catch (_) { throw new Error('база не ответила') }

  if (r.status === 401 || r.status === 403) throw new Error('токен не принят');
  if (!r.ok) throw new Error('база ответила ' + r.status);
  const u = await r.json().catch(() => null);
  if (!u || !u.id) throw new Error('база не назвала пользователя');
  return { uid: u.id, email: u.email || '' };
}

/* ── 2.5 ВХОД БЕЗ ИНТЕРНЕТА (users.json) ──────────────────────────

   Лагерь стоит в поле, и Supabase там может не быть вовсе — ни проекта,
   ни связи. Тогда список доступа это файл рядом с панелью, как было
   раньше: логин, роль и хэш пароля.

   ПРАВИЛО «ИЛИ — ИЛИ», и оно важнее удобства. Если база настроена, она
   единственный список: файл не читается вообще. Если базы нет — только
   файл. Два действующих списка одновременно означали бы два разных
   ответа на вопрос «кто здесь главный», а сходиться им негде.

   ГДЕ СЧИТАЕТСЯ ХЭШ. Здесь, на сервере. Раньше пароль проверяла сама
   панель в браузере — и это честно называлось слабым местом: клиентскую
   проверку обходят инструментами разработчика, а файл с хэшами до неё
   успевал уехать в браузер. Теперь наружу не уходит ни файл, ни ответ
   подробнее «не подходит», а панель получает ту же подписанную куку,
   что и при входе через базу. Остальной код про два входа не знает.

   Параметры обязаны совпадать с теми, которыми хэши создавались
   (deploy/mkuser.mjs, ныне удалённый, и старый admin.html): PBKDF2-SHA256,
   120 000 итераций, 32 байта, соль КАК СТРОКА — браузер делал
   TextEncoder().encode(salt), а не разбирал hex. Разойдись параметры —
   пароли просто перестали бы подходить, и понять это было бы неоткуда.
   Поэтому в selftest лежит вектор, снятый с настоящего crypto.subtle. */

const ITER = 120000;
export const hashPass = (pass, salt) =>
  pbkdf2Sync(String(pass), String(salt), ITER, 32, 'sha256').toString('hex');

/* Возвращает {uid, role, name} или null. Причину отказа наружу не
   отдаём: «нет такого логина», «не тот пароль» и «доступ отключён» для
   вошедшего одно и то же, а разница подсказывала бы, какой логин есть. */
export function verifyLocal(users, login, pass){
  if (!Array.isArray(users) || !login || !pass) return null;
  const key = String(login).trim().toLowerCase();
  const u = users.find(x => x && String(x.login || '').trim().toLowerCase() === key);
  if (!u || u.off || !u.salt || !u.hash || !ROLES.has(u.role)) return null;

  const want = Buffer.from(String(u.hash), 'hex');
  const got  = Buffer.from(hashPass(pass, u.salt), 'hex');
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null;

  /* uid с приставкой: он попадёт в подпись куки, и путать человека из
     файла с человеком из базы (там uid — это UUID) нельзя. */
  return { uid: 'file:' + u.login, role: u.role, name: u.name || u.login };
}

/* ── 3. ПРОВЕРКА ─────────────────────────────────────────────────
   node auth.mjs --selftest. Отдельно от server.mjs: подпись и срок —
   та часть, где тихая ошибка означает чужой вход, и проверять её надо
   не «заодно». */

export function selftest(){
  const a = (ok, what) => { console.log((ok ? '  ok   ' : '  ПЛОХО') + '  ' + what);
                            if (!ok) process.exitCode = 1; };
  const S = secretFrom('service-key');
  const NOW = 1_700_000_000_000;
  const UID = '11111111-2222-3333-4444-555555555555';

  console.log('\nПОДПИСЬ');
  const t = sign(UID, 'admin', S, NOW);
  const got = parse(t, S, NOW);
  a(got && got.uid === UID && got.role === 'admin', 'своя кука читается обратно');
  a(parse(t, secretFrom('другой-ключ'), NOW) === null, 'чужим секретом не читается');
  a(parse(t.slice(0, -2) + 'xx', S, NOW) === null,      'испорченная подпись не проходит');
  /* Главная проверка этого файла: роль в payload нельзя поменять, не
     сломав подпись. Если бы можно — стойка выписала бы себе штаб.
     Берём НАСТОЯЩУЮ куку стойки и подставляем в неё admin, оставив
     подпись стойки: именно так выглядела бы попытка. */
  const desk = sign(UID, 'desk', S, NOW);
  const swapped = Buffer.from(`${UID}|admin|${Math.floor(NOW/1000)+TTL}`).toString('base64url');
  a(parse(swapped + '.' + desk.split('.')[1], S, NOW) === null, 'подменённая роль не проходит');
  /* И срок тоже: продлить себя, не переподписав, нельзя. */
  const late = Buffer.from(`${UID}|desk|${Math.floor(NOW/1000)+TTL*100}`).toString('base64url');
  a(parse(late + '.' + desk.split('.')[1], S, NOW) === null, 'продлённый срок не проходит');
  a(parse('', S, NOW) === null && parse('a.b', S, NOW) === null && parse(null, S, NOW) === null,
                                                        'мусор вместо куки не проходит');
  a(parse(t, null, NOW) === null,                       'без секрета не проходит никто');

  console.log('\nСРОК');
  a(parse(t, S, NOW + (TTL - 60) * 1000) !== null,      'до срока кука жива');
  a(parse(t, S, NOW + (TTL + 60) * 1000) === null,      'после срока — нет');

  console.log('\nРОЛИ');
  a(['admin','lead','desk','content'].every(r => parse(sign(UID, r, S, NOW), S, NOW).role === r),
                                                        'все четыре роли подписываются');
  let threw = false;
  try { sign(UID, 'КОРОЛЬ', S, NOW); } catch (_) { threw = true }
  a(threw, 'роли не из списка не подписываются');
  threw = false;
  try { sign('', 'admin', S, NOW); } catch (_) { threw = true }
  a(threw, 'без uid не подписывается');

  console.log('\nЗАГОЛОВОК');
  a(fromHeader('camp=abc') === 'abc',                   'кука читается');
  a(fromHeader('x=1; camp=abc; y=2') === 'abc',         'читается среди других');
  a(fromHeader('camping=abc') === '',                   'похожее имя не подходит');
  a(fromHeader('') === '' && fromHeader(undefined) === '', 'пустой заголовок — пусто');
  a(who({ headers:{ cookie:'camp=' + t } }, S, NOW).role === 'admin', 'who() достаёт роль');
  a(who({ headers:{} }, S, NOW) === null,               'без куки — никто');

  console.log('\nSET-COOKIE');
  a(setCookie('t').includes('HttpOnly') && setCookie('t').includes('SameSite=Lax'),
                                                        'кука закрыта от скриптов');
  a(!setCookie('t').includes('Secure') && setCookie('t', { secure:true }).includes('Secure'),
                                                        'Secure только на https');
  a(clearCookie().includes('Max-Age=0'),                'выход гасит куку');

  console.log('\nВХОД БЕЗ ИНТЕРНЕТА');
  /* Вектор снят с настоящего crypto.subtle в браузере на тех же
     параметрах, что были в admin.html и mkuser.mjs. Перестанет
     совпадать — старые пароли из users.json не подойдут, и понять
     это будет неоткуда. */
  a(hashPass('test123', 'abcdef0123456789') ===
    'e16b6253f327c5546876d33f19c1809b5ab276b14efdc6eb63a49d6ef14f8932',
                                                        'хэш совпадает с прежними паролями');
  const salt = 'abcdef0123456789';
  const US = [{ login:'admin', name:'Организатор', role:'admin',
                salt, hash: hashPass('пароль', salt), off:false },
              { login:'Аня',   name:'Аня', role:'desk',
                salt, hash: hashPass('вторая', salt), off:false },
              { login:'ушёл',  name:'Ушёл', role:'admin',
                salt, hash: hashPass('пароль', salt), off:true }];
  a(verifyLocal(US, 'admin', 'пароль').role === 'admin',  'свой пароль подходит');
  a(verifyLocal(US, 'ADMIN', 'пароль') !== null,          'логин без учёта регистра');
  a(verifyLocal(US, ' admin ', 'пароль') !== null,        'пробелы вокруг логина не мешают');
  a(verifyLocal(US, 'admin', 'пароль ') === null,         'пароль сверяется точно');
  a(verifyLocal(US, 'admin', 'не тот') === null,          'чужой пароль не подходит');
  a(verifyLocal(US, 'нет такого', 'пароль') === null,     'неизвестный логин не подходит');
  /* Отключённый — с ВЕРНЫМ паролем: именно это и проверяем. */
  a(verifyLocal(US, 'ушёл', 'пароль') === null,           'отключённый не входит с верным паролем');
  a(verifyLocal(US, 'Аня', 'вторая').role === 'desk',     'роль берётся из файла, а не угадывается');
  a(verifyLocal(US, 'admin', '') === null && verifyLocal(US, '', 'пароль') === null,
                                                          'пустые поля не проходят');
  a([null, undefined, 'строка', {}, [{}], [{login:'admin',role:'admin'}]]
      .every(v => verifyLocal(v, 'admin', 'пароль') === null),
                                                          'битый файл не пускает никого');
  /* Роль не из списка — отказ, а не «пусть будет стойка»: подправленный
     руками users.json не должен выдумывать права. */
  a(verifyLocal([{ login:'x', role:'КОРОЛЬ', salt, hash: hashPass('п', salt) }], 'x', 'п') === null,
                                                          'выдуманная роль в файле не проходит');
  a(verifyLocal(US, 'admin', 'пароль').uid === 'file:admin',
                                                          'uid из файла отличим от uid из базы');
  a(sign(verifyLocal(US, 'Аня', 'вторая').uid, 'desk', S, NOW).length > 20,
                                                          'вход из файла получает такую же куку');

  console.log('\nТОКЕН');
  const fake = (status, body) => async () => ({ ok: status === 200, status,
                                                json: async () => body });
  (async () => {
    const ok = await verify('tok', { url:'https://x.supabase.co', anon:'k',
                                     fetchImpl: fake(200, { id: UID, email:'a@b' }) });
    a(ok.uid === UID, 'ответ базы даёт uid');
    for (const [st, what] of [[401,'401 — отказ'], [500,'500 — отказ']]){
      let bad = false;
      try { await verify('tok', { url:'https://x', anon:'k', fetchImpl: fake(st, {}) }); }
      catch (_) { bad = true }
      a(bad, what);
    }
    let noId = false;
    try { await verify('tok', { url:'https://x', anon:'k', fetchImpl: fake(200, {}) }); }
    catch (_) { noId = true }
    a(noId, 'ответ без id — отказ');
    let noCfg = false;
    try { await verify('tok', { url:'', anon:'' }); } catch (_) { noCfg = true }
    a(noCfg, 'без настроек базы вход не выдаётся');
    console.log('');
  })();
}

if (process.argv.includes('--selftest')) selftest();
