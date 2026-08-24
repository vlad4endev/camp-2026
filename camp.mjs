/* Содержимое лагеря — одна регулярка на весь проект.

   Раньше блок `const CAMP={…}` из landing.html выковыривали четверо, и
   каждый своей копией выражения: server.mjs, bots.mjs, admin.html и
   enter.html. Копии совпадали, пока их не трогали, — а «пока не трогали»
   не свойство кода, а везение. Стоило поменять границу блока в одном
   месте, и остальные трое молча получали бы старые данные: не ошибку, а
   вчерашнее расписание, которое выглядит как сегодняшнее.

   Теперь выражение здесь одно, и меняется тоже здесь одно.

   ПОЧЕМУ ДАННЫЕ ВООБЩЕ ЛЕЖАТ ВНУТРИ HTML. Лендинг — PWA: телефон обязан
   открыть его без сети и показать расписание. Вынести содержимое в
   отдельный запрос значит показать пустую страницу тому, кто в лесу.
   Поэтому литерал остаётся в файле — но перестаёт быть источником:
   писать в него теперь умеет только injectCamp(), и зовут её из одного
   места (PUT /camp в server.mjs).

   Браузерная половина этого же — camp-ui.js.                            */

import { createHash } from 'node:crypto';

/* Закрывающая «};» с начала строки — граница блока: все вложенные скобки
   внутри CAMP идут с отступом. */
export const CAMP_RE = /const CAMP\s*=\s*\{[\s\S]*?\n\};/;

/* Версия — хэш самого литерала, а не файла: правка вёрстки не должна
   заставлять полсотни телефонов перерисовываться на ровном месте. */
export const versionOf = src => createHash('sha256').update(src).digest('hex').slice(0, 12);

export function parseCamp(html){
  const m = html.match(CAMP_RE);
  if (!m) throw new Error('в landing.html не найден блок const CAMP={…};');
  return new Function('return (' + m[0].slice(m[0].indexOf('{'), -1) + ')')();
}

/* Разбор вместе с версией: обоим читателям нужно и то и другое, а считать
   версию по-разному — тот же способ разойтись, от которого уходим. */
export function campOf(html){
  const m = html.match(CAMP_RE);
  if (!m) throw new Error('в landing.html не найден блок const CAMP={…};');
  const src = m[0].slice(m[0].indexOf('{'), -1);
  return { v: versionOf(src), camp: new Function('return (' + src + ')')() };
}

export function injectCamp(html, camp){
  if (!CAMP_RE.test(html))
    throw new Error('блок CAMP не найден — landing.html изменился?');
  /* Функция-заменитель, а не строка: в данных встречаются $&, $1 и прочие
     спецпоследовательности replace, и подставленные буквально они молча
     съели бы кусок расписания. */
  return html.replace(CAMP_RE, () => 'const CAMP=' + JSON.stringify(camp, null, 2) + ';');
}

/* ── Проверка ──────────────────────────────────────────────────── */

export function selftest(){
  const a = (ok, what) => { console.log((ok ? '  ok   ' : '  ПЛОХО') + '  ' + what);
                            if (!ok) process.exitCode = 1; };
  const html = ['<script>', 'const CAMP={', '  year:2026,', '  days:[{ date:1 }],',
                '};', 'const OTHER={', '  x:1,', '};', '</' + 'script>'].join('\n');

  a(parseCamp(html).year === 2026,                  'литерал разбирается');
  a(parseCamp(html).days.length === 1,              'вложенные скобки не обрывают блок');
  a(campOf(html).v.length === 12,                   'версия — 12 знаков');
  a(campOf(html).v === campOf(html).v,              'версия воспроизводится');
  a(campOf(html).v !== campOf(html.replace('2026', '2027')).v,
                                                    'правка данных меняет версию');
  a(campOf(html).v === campOf(html + '\n<!-- вёрстка -->').v,
                                                    'правка вёрстки версию не трогает');

  const back = injectCamp(html, { year: 2027, note: 'цена $1 за $& штуку' });
  a(parseCamp(back).year === 2027,                  'запись возвращается разбором');
  a(parseCamp(back).note === 'цена $1 за $& штуку',  '$1 и $& не съедаются replace');
  a(back.includes('const OTHER={'),                 'соседний блок не задет');
  a(/\}\;\s*$/m.test(back.match(CAMP_RE)[0]),       'граница блока на месте');

  let threw = false;
  try { parseCamp('<p>не лендинг</p>'); } catch { threw = true }
  a(threw,                                          'чужой файл — ошибка, а не пустой CAMP');
  threw = false;
  try { injectCamp('<p>не лендинг</p>', {}); } catch { threw = true }
  a(threw,                                          'писать в чужой файл нельзя');
}

if (process.argv[1] && process.argv[1].endsWith('camp.mjs')) selftest();
