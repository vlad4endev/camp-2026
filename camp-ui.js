/* Общий слой панелей: штаб, стойка и дверь.

   ПОЧЕМУ ЭТОТ ФАЙЛ ВООБЩЕ ПОЯВИЛСЯ. Три страницы делают три разных дела,
   но здороваются с сервером одинаково: спросить «кто я», прочитать файл,
   записать файл, показать плашку. Пока этого кода было по копии на
   страницу, он не ломался — он расходился. Молча и по мелочи:

     toast   держался 2600 мс в штабе и 2800 на стойке
     --r     скруглял на 10px в штабе и на 14px на стойке
     --sh    ронял разную тень под одинаковыми карточками

   Ни одно из этих расхождений никто не выбирал. Их просто скопировали и
   потом поправили в одном месте из двух. Отдельно каждое — пустяк; вместе
   они означают, что «панель лагеря» выглядит и ведёт себя как два разных
   продукта, и человек, который утром на стойке, а вечером в штабе, каждый
   раз заново понимает, куда нажимать.

   Теперь общее лежит здесь. Тем же приёмом, что camp-db.js: обычный
   <script>, без сборки и без модулей, чтобы страницы по-прежнему
   открывались двойным щелчком.

   ПОЧЕМУ ПРИСВАИВАЕМ В window, А НЕ ОБЪЯВЛЯЕМ. Классические скрипты
   делят одну лексическую область: `var toast` здесь и `const toast` в
   странице — это SyntaxError на весь файл, а не тихое переопределение.
   Присваивание свойства такого столкновения не создаёт, и на стороне
   страницы вызовы остаются прежними — `toast(…)`, а не `CampUI.toast(…)`.

   Чего здесь нет и не будет: входа (signIn у штаба и стойки разный по
   смыслу — они пускают в разные места) и любых данных. Данные — camp-db.js
   и GET /camp.

   Оформление — camp-ui.css рядом.                                        */

(function(global){
'use strict';

/* ── 1. МЕЛОЧИ ──────────────────────────────────────────────────
   Второй аргумент — корень поиска: дверь звала $ с одним, штаб с двумя.
   Подпись с умолчанием покрывает оба вызова. */
const $  = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

/* Русское склонение по числу: [1, 2-4, 5-20]. Дословно совпадало в обеих
   панелях — значит и ошибка в нём была бы одна на двоих, что лучше двух
   разных. */
function plural(n, f){
  const a = Math.abs(n) % 100, b = a % 10;
  if (a > 10 && a < 20) return f[2];
  if (b > 1 && b < 5)   return f[1];
  if (b === 1)          return f[0];
  return f[2];
}

/* 2800 мс — то, что было на стойке. Взяли большее из двух намеренно:
   на стойке плашкой подтверждается принятый взнос, и человек читает её,
   не отрываясь от денег в руках. В штабе лишние 200 мс не мешают. */
const TOAST_MS = 2800;

function toast(text, kind){
  const box = $('#toasts');
  if (!box) return;                       // страница без места под плашки — молчим
  const el = document.createElement('div');
  el.className = 'toast' + (kind ? ' ' + kind : '');
  el.textContent = text;                  // textContent, не innerHTML: в тексте бывают имена
  box.append(el);
  setTimeout(() => el.remove(), TOAST_MS);
}

/* ── 2. КТО Я ───────────────────────────────────────────────────
   Роль спрашиваем у сервера, а не у браузера: в куке она подписана
   (auth.mjs), и подделать её нельзя, а sessionStorage правится в консоли
   за секунду. Не ответил — считаем, что не вошли: «не знаю» здесь должно
   означать «нельзя», а не «наверное можно». */
async function serverWho(){
  try {
    const r = await fetch('whoami', { cache:'no-store' });
    if (!r.ok) return null;
    const me = await r.json();
    return me && me.role ? me : null;
  } catch (_) { return null }
}

async function signOut(){
  try { await fetch('signout', { method:'POST' }); } catch (_) {}
}

/* ── 3. ФАЙЛ НА СЕРВЕРЕ ─────────────────────────────────────────
   Прикидывается FileSystemFileHandle: панели умеют работать и с диском
   (ноутбук без сети), и через сервер, и вся разница должна быть здесь, а
   не в каждом месте, где что-то сохраняется.

   srv:true — единственное, чем этот хэндл отличается снаружи. У настоящего
   FileSystemFileHandle тоже kind==='file', и без метки штаб не мог бы
   понять, слать ему данные (PUT /camp) или файл целиком.               */
function srvFile(name){
  return { kind:'file', name, srv:true,
    async getFile(){
      const r = await fetch(name + '?t=' + Date.now(), { cache:'no-store' });
      if (!r.ok) throw new Error(name + ': HTTP ' + r.status);
      const text = await r.text();
      /* X-Mtime ставит server.mjs: по нему панель ловит чужую правку.
         Last-Modified не годится — у него разрешение в секунду, а две
         правки подряд укладываются в одну. */
      return { name, lastModified: Number(r.headers.get('X-Mtime')) || 0,
               text: async () => text };
    },
    async createWritable(){
      let buf = '';
      return {
        write: async t => { buf += t; },
        close: async () => {
          const r = await fetch(name, { method:'PUT', body: buf });
          if (r.ok) return;
          let why = '';
          try { why = (await r.json()).error || ''; } catch (_) {}
          /* Молчать нельзя: панель считала бы правку сохранённой, а лагерь
             видел бы старое — на стойке это незаписанный взнос, в штабе
             вчерашнее расписание. Пусть падает громко. */
          throw new Error('сервер не принял ' + name + ': ' + (why || 'HTTP ' + r.status));
        } };
    } };
}

/* ── 4. БЛОК CAMP ───────────────────────────────────────────────
   Браузерная половина camp.mjs. Две копии на два рантайма — минимум,
   ниже которого не опуститься: <script> не умеет ESM без сборки, а
   страницы обязаны открываться двойным щелчком. Было четыре.

   Штабу это нужно НЕ для данных: расписание он берёт из GET /camp или из
   базы, а сохраняет через PUT /camp. Нужно для файла, открытого с диска
   (ноутбук без сети) и для экспорта готовой страницы одним файлом.

   Граница блока — «};» с начала строки: всё вложенное внутри CAMP идёт
   с отступом. Ровно то же выражение, что в camp.mjs; если менять — то
   там и здесь одним движением. */
const CAMP_RE = /const CAMP\s*=\s*\{[\s\S]*?\n\};/;

function parseCamp(html){
  const m = html.match(CAMP_RE);
  if (!m) throw new Error('В файле не найден блок «const CAMP={…};» — это точно landing.html?');
  return new Function('return (' + m[0].slice(m[0].indexOf('{'), -1) + ')')();
}

function injectCamp(html, camp){
  if (!CAMP_RE.test(html)) throw new Error('Блок CAMP не найден — файл изменился?');
  /* Функция-заменитель, а не строка: в данных встречаются /* ── 4. САМОПРОВЕРКА ──────────────────────────────────────────── и $1, и
     подставленные буквально они молча съели бы кусок расписания. */
  return html.replace(CAMP_RE, () => 'const CAMP=' + JSON.stringify(camp, null, 2) + ';');
}

/* ── 4. САМОПРОВЕРКА ────────────────────────────────────────────
   Возвращает список, а не печатает: страницы показывают его своим
   способом (admin.html#selftest, reception.html#selftest). */
function selftest(){
  const out = [];
  const a = (what, ok) => out.push({ what, ok });
  const P = ['день', 'дня', 'дней'];

  a('склонение: 1 день',      plural(1, P)  === 'день');
  a('склонение: 2 дня',       plural(2, P)  === 'дня');
  a('склонение: 5 дней',      plural(5, P)  === 'дней');
  a('склонение: 11 дней',     plural(11, P) === 'дней');   // не «11 день»
  a('склонение: 21 день',     plural(21, P) === 'день');
  a('склонение: 112 дней',    plural(112, P)=== 'дней');
  a('склонение: 0 дней',      plural(0, P)  === 'дней');
  a('склонение: −2 дня',      plural(-2, P) === 'дня');

  const H = ['<scr'+'ipt>', 'const CAMP={', '  year:2026,', '  days:[{ date:1 }],', '};',
             'const OTHER={', '  x:1,', '};'].join('\n');
  a('CAMP разбирается',        parseCamp(H).year === 2026);
  a('вложенные скобки целы',   parseCamp(H).days.length === 1);
  a('обратная запись',         parseCamp(injectCamp(H, { year:2027 })).year === 2027);
  a('$& не съедается replace', parseCamp(injectCamp(H, { s:'цена $& и $1' })).s === 'цена $& и $1');
  a('соседний блок не задет',  injectCamp(H, { year:1 }).includes('const OTHER={'));
  a('чужой файл отклоняется',  (() => { try { parseCamp('<p>нет</p>'); return false } catch (_) { return true } })());

  a('серверный файл помечен', srvFile('x.json').srv === true);
  a('имя файла сохранено',    srvFile('x.json').name === 'x.json');
  a('плашка без места молчит', (() => {
      try { toast('нет #toasts'); return true; } catch (_) { return false }
    })());
  return out;
}

global.CampUI = { $, $$, plural, toast, serverWho, signOut, srvFile,
                  CAMP_RE, parseCamp, injectCamp, selftest, TOAST_MS };

/* Вызовы на страницах остаются прежними: toast(…), $('#x'), srvFile(…).
   Страница вправе объявить своё — её `const` просто заслонит это. */
for (const k of ['$', '$$', 'plural', 'toast', 'serverWho', 'srvFile',
                 'parseCamp', 'injectCamp'])
  if (!(k in global)) global[k] = global.CampUI[k];

})(window);
