-- Проверка схемы на настоящем Postgres.
--
--   psql -f supabase/schema.sql -f supabase/schema.test.sql
--
-- Фикстура взята из `node server.mjs --selftest` дословно. Это главное:
-- правило «один человек не занимает два места» переехало из JS в SQL, и
-- разойтись им нельзя — иначе лендинг показывал бы одно, а база держала
-- другое. Если этот файл проходит, оба считают одинаково.
--
-- В Supabase auth.users и auth.uid() уже есть; локально нужен шим —
-- см. раздел «Проверка схемы» в supabase/README.md.

\set ON_ERROR_STOP on
\pset pager off

create or replace function ok(what text, cond boolean) returns void
language plpgsql as $$
begin
  raise notice '%  %', case when cond then 'ok   ' else 'НЕ ОК' end, what;
  if not cond then
    raise exception 'проверка не прошла: %', what;
  end if;
end $$;

begin;

-- ── фикстура ──────────────────────────────────────────────────────
insert into camp_content (id, doc) values (1, '{"classes":[
  {"name":"Музыка","day":"СР","cap":3},
  {"name":"Музыка","day":"ЧТ","cap":3},
  {"name":"Спорт","cap":0}
]}'::json)
on conflict (id) do update set doc = excluded.doc;

insert into participants (id, name, phone, classes, status) values
  ('anya',  'Аня',   '+7 900 111-22-33', '{"Музыка · СР"}', 'confirmed'),
  ('borya', 'Боря',  '',                 '{"Музыка · СР"}', 'confirmed'),
  ('otkaz', 'Отказ', '+7 900 999-99-99', '{"Музыка · СР"}', 'cancelled');

insert into signups (who, name, cls) values
  ('p:9001112233', 'Аня',  'Музыка · СР'),      -- Аня уже посчитана как участник
  ('i:tg777777',   'Женя', 'Музыка · СР');

-- ── вычисляемые поля повторяют функции из server.mjs ──────────────
select ok('номер сворачивается в последние 10 цифр',
  (select phone_key from participants where id = 'anya') = '9001112233');
select ok('имя сворачивается для сравнения',
  (select name_key from participants where id = 'anya') = 'аня');

-- ── занятость: тот же ответ, что takenOf() в JS ───────────────────
select ok('один человек не занимает два места', seats_taken('Музыка · СР') = 3);
select ok('в пустой группе никого',             seats_taken('Музыка · ЧТ') = 0);

update participants set status = 'cancelled' where id = 'borya';
select ok('отказавшийся место не держит', seats_taken('Музыка · СР') = 2);
update participants set status = 'confirmed' where id = 'borya';

select ok('один класс в разные дни — разные группы',
  (select count(*) from camp_classes()) = 3);
select ok('cap читается из документа лагеря',
  (select cap from camp_classes() where cls = 'Музыка · СР') = 3);
select ok('пустой cap — это ноль, то есть без ограничения',
  (select cap from camp_classes() where cls = 'Спорт') = 0);

select ok('seats() отдаёт занято и всего',
  (seats() -> 'Музыка · СР' ->> 'taken') = '3' and
  (seats() -> 'Музыка · СР' ->> 'cap')   = '3');

-- ── лимит: то, чего файловая версия не умела ──────────────────────
-- Занято 3 из 3, значит следующий получает отказ, а не место.
select ok('в заполненную группу не записывают',
  (claim_seat('p:9005550000', 'Новенький', '', 'Музыка · СР', false) ->> 'error') = 'full');
select ok('отказ не создал строку',
  not exists (select 1 from signups where who = 'p:9005550000'));

select ok('без ограничения места не кончаются',
  (claim_seat('p:9005550000', 'Новенький', '', 'Спорт', false) ->> 'ok') = 'true');

select ok('незнакомая группа отбивается',
  (claim_seat('p:9005550000', 'Новенький', '', 'Такой нет', false) ->> 'error') = 'no_class');

-- Повтор из офлайн-очереди не должен превращаться в ошибку и не должен
-- создавать вторую запись: на этом стоит вся досылка.
select ok('повтор записи — успех, а не отказ',
  (claim_seat('p:9005550000', 'Новенький', '', 'Спорт', false) ->> 'dup') = 'true');
select ok('повтор не создал вторую строку',
  (select count(*) from signups where who = 'p:9005550000' and cls = 'Спорт') = 1);

select ok('отмена снимает запись',
  (claim_seat('p:9005550000', 'Новенький', '', 'Спорт', true) ->> 'ok') = 'true');
select ok('после отмены строки нет',
  not exists (select 1 from signups where who = 'p:9005550000' and cls = 'Спорт'));
select ok('отмена того, чего не было, не ломается',
  (claim_seat('p:9005550000', 'Новенький', '', 'Спорт', true) ->> 'ok') = 'true');

select ok('запись без «кто» не проходит',
  (claim_seat('', 'Никто', '', 'Спорт', false) ->> 'error') = 'bad');
select ok('запись без имени не проходит',
  (claim_seat('p:9005550001', '', '', 'Спорт', false) ->> 'error') = 'bad');

-- Место освободилось — следующий проходит. Проверяем, что отказ выше
-- был про лимит, а не про что-то другое.
delete from signups where who = 'i:tg777777';
select ok('освободившееся место занимается',
  (claim_seat('p:9005550002', 'Ещё один', '', 'Музыка · СР', false) ->> 'ok') = 'true');
select ok('и снова закрыто',
  (claim_seat('p:9005550003', 'Третий', '', 'Музыка · СР', false) ->> 'error') = 'full');

-- ── «кто я»: наружу уходит только сам человек ─────────────────────
select ok('участник находится по номеру в любом написании',
  (whoami('8 900 111 22 33') ->> 'name') = 'Аня'
  and (whoami('+7 (900) 111-22-33') ->> 'name') = 'Аня');
select ok('незнакомый номер получает отказ',
  (whoami('+7 900 000-00-00') ->> 'error') = 'not_found');
select ok('огрызок вместо номера отброшен',
  (whoami('12345') ->> 'error') = 'bad');

insert into signups (who, name, cls) values ('p:9001112233', 'Аня', 'Спорт');
select ok('свои записи видны',
  (whoami('9001112233') -> 'mine') ? 'Спорт');

-- Различие «своё / вписал штаб» — по наличию строки в signups, а не по
-- classes: «Музыка · СР» стоит у Ани и в classes, и в её записях, значит
-- это ЕЁ запись и снять её она может. А вот «Музыка · ЧТ» ей вписал штаб.
update participants set classes = classes || '{"Музыка · ЧТ"}' where id = 'anya';
select ok('своя запись остаётся своей, даже если она же есть в classes',
  (whoami('9001112233') -> 'mine') ? 'Музыка · СР'
  and not ((whoami('9001112233') -> 'locked') ? 'Музыка · СР'));
select ok('запись штаба лежит отдельно — участник её не снимет',
  (whoami('9001112233') -> 'locked') ? 'Музыка · ЧТ');
select ok('чужих имён в ответе нет',
  whoami('9001112233')::text not like '%Боря%'
  and whoami('9001112233')::text not like '%Женя%');

-- ── деньги считаются из строк, а не из поля ───────────────────────
insert into payments (participant_id, at, sum) values
  ('anya', '2026-08-26', 3000), ('anya', '2026-08-27', 2000);
update participants set fee = 8000 where id = 'anya';
select ok('внесено — сумма взносов',
  (select paid from participants_money where id = 'anya') = 5000);
select ok('долг — разница',
  (select debt from participants_money where id = 'anya') = 3000);
insert into payments (participant_id, sum) values ('anya', 5000);
select ok('переплата не даёт отрицательного долга',
  (select debt from participants_money where id = 'anya') = 0);

-- Удаление участника уносит его взносы, а не оставляет их сиротами.
insert into participants (id, name) values ('tmp', 'Временный');
insert into payments (participant_id, sum) values ('tmp', 100);
delete from participants where id = 'tmp';
select ok('взносы удалённого участника не остаются сиротами',
  not exists (select 1 from payments where participant_id = 'tmp'));

-- ── версия документа считается базой ──────────────────────────────
select ok('версия проставлена триггером',
  (select length(version) from camp_content where id = 1) = 12);
update camp_content set doc = '{"classes":[],"changed":true}'::json where id = 1;
select ok('версия меняется вместе с документом',
  (select version from camp_content where id = 1)
    = left(md5('{"classes":[],"changed":true}'), 12));

-- ── ГРАНИЦА ДОСТУПА ──────────────────────────────────────────────
-- Главное свойство всей схемы: роль anon не видит ничего. Это SQL-версия
-- белого списка PUBLIC_FILES. Проверяем настоящим переключением роли.
select ok('RLS включён на всех таблицах',
  (select bool_and(relrowsecurity) from pg_class
    where relname in ('staff','participants','payments','signups',
                      'camp_content','rooms','bot_links','integrations')));

grant select on all tables in schema public to anon;   -- нарочно даём права…
set local role anon;
select ok('anon не видит участников',   (select count(*) from participants) = 0);
select ok('anon не видит взносы',       (select count(*) from payments) = 0);
select ok('anon не видит записи',       (select count(*) from signups) = 0);
select ok('anon не видит токены ботов', (select count(*) from integrations) = 0);
select ok('anon не видит расписание',   (select count(*) from camp_content) = 0);
reset role;
-- …и всё равно ноль: права на таблицу есть, политики нет. Именно так и
-- должно быть — SELECT без политики возвращает пустоту.

select ok('anon не может позвать whoami',
  not has_function_privilege('anon', 'whoami(text)', 'execute'));
select ok('anon не может позвать claim_seat',
  not has_function_privilege('anon', 'claim_seat(text,text,text,text,boolean)', 'execute'));
select ok('персоналу whoami доступен',
  has_function_privilege('authenticated', 'whoami(text)', 'execute'));

-- ── роли персонала ───────────────────────────────────────────────
insert into auth.users (id, email) values
  ('11111111-1111-1111-1111-111111111111', 'glavny@camp'),
  ('22222222-2222-2222-2222-222222222222', 'redaktor@camp'),
  ('33333333-3333-3333-3333-333333333333', 'nikto@camp');
insert into staff (user_id, email, name, role) values
  ('11111111-1111-1111-1111-111111111111', 'glavny@camp',   'Главный',  'admin'),
  ('22222222-2222-2222-2222-222222222222', 'redaktor@camp', 'Редактор', 'content');

/* ── лагерь не остаётся без главного ──
   Это единственная блокировка панели, из которой нет выхода изнутри:
   без активного admin никто не сможет выдать роль обратно. Проверяем в
   базе, потому что кнопку в интерфейсе можно обойти запросом. */
/* set constraints immediate обязателен: триггер отложенный, то есть по
   умолчанию срабатывает на commit — а внутри блока с exception коммита
   нет, и проверка бы просто не запустилась. Ровно так этот тест сначала
   и «прошёл», ничего не проверив. */
do $$ begin
  update staff set role = 'lead' where role = 'admin';
  set constraints all immediate;
  raise exception 'последнего главного разжаловали — триггер не работает';
exception
  when others then
    if sqlerrm not like '%без активного%' then raise; end if;
end $$;
select ok('последнего главного нельзя разжаловать',
  (select role from staff where user_id = '11111111-1111-1111-1111-111111111111') = 'admin');

do $$ begin
  update staff set off = true where role = 'admin';
  set constraints all immediate;
  raise exception 'последнего главного отключили — триггер не работает';
exception
  when others then
    if sqlerrm not like '%без активного%' then raise; end if;
end $$;
select ok('последнего главного нельзя отключить',
  not (select off from staff where user_id = '11111111-1111-1111-1111-111111111111'));

-- А вот «назначил второго и разжаловал себя» пройти обязано: именно
-- поэтому триггер отложенный, а не построчный.
insert into staff (user_id, email, name, role) values
  ('33333333-3333-3333-3333-333333333333', 'nikto@camp', 'Второй', 'admin');
update staff set role = 'lead' where user_id = '11111111-1111-1111-1111-111111111111';
select ok('передать роль главного другому можно',
  (select count(*) from staff where role = 'admin' and not off) = 1);
delete from staff where user_id = '33333333-3333-3333-3333-333333333333';
update staff set role = 'admin' where user_id = '11111111-1111-1111-1111-111111111111';

grant select, insert, update, delete on all tables in schema public to authenticated;

set local role authenticated;
set local "request.jwt.claim.sub" = '33333333-3333-3333-3333-333333333333';
select ok('вошедший, но не внесённый в штаб, не видит участников',
  (select count(*) from participants) = 0);

set local "request.jwt.claim.sub" = '11111111-1111-1111-1111-111111111111';
select ok('главный видит участников', (select count(*) from participants) >= 3);
select ok('главный видит токены ботов', (select count(*) from integrations) = 1);

set local "request.jwt.claim.sub" = '22222222-2222-2222-2222-222222222222';
select ok('редактор НЕ видит персональных данных вовсе',
  (select count(*) from participants) = 0 and (select count(*) from payments) = 0);
select ok('редактор правит расписание', is_staff(array['admin','content']));
select ok('редактор видит расписание',  (select count(*) from camp_content) = 1);
select ok('редактор НЕ видит токены ботов', (select count(*) from integrations) = 0);

/* ВАЖНО ПРО RLS: на UPDATE и DELETE политика не поднимает ошибку — она
   просто не находит строк, и запрос «успешно» меняет ноль записей. На
   INSERT наоборот: WITH CHECK срабатывает громко. Проверяем оба, потому
   что тихий отказ легко принять за успешное сохранение. */
update participants set room = '99' where id = 'anya';
select ok('правка участника редактором меняет ноль строк',
  (select count(*) from participants where room = '99') = 0);

do $$ begin
  insert into participants (id, name) values ('vzlom', 'Не должен появиться');
  raise exception 'редактор создал участника — политика не работает';
exception
  when insufficient_privilege then null;      -- этого и ждём
end $$;
select ok('редактор не может создать участника', true);
reset role;

/* Тихий отказ проверяем и с той стороны, где он обязан быть настоящим
   отказом: комната Ани не изменилась, значит запрос выше действительно
   ничего не сделал, а не был отменён откатом транзакции. */
select ok('комната Ани осталась прежней',
  (select coalesce(room, '') from participants where id = 'anya') <> '99');

set local role authenticated;
set local "request.jwt.claim.sub" = '11111111-1111-1111-1111-111111111111';
update participants set room = '77' where id = 'anya';
select ok('главный участника править может',
  (select room from participants where id = 'anya') = '77');
reset role;

rollback;

\echo ''
\echo '  Схема проверена: всё сошлось.'
\echo ''
