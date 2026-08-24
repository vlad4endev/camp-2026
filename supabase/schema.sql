-- ╔══════════════════════════════════════════════════════════════════╗
-- ║  Единая база лагеря. Применять в SQL Editor проекта Supabase.     ║
-- ║  Файл идемпотентный: можно прогнать повторно, ничего не потеряв.  ║
-- ╚══════════════════════════════════════════════════════════════════╝
--
-- КТО СЮДА ХОДИТ И КАК
--
--   admin.html, reception.html  → напрямую, ключ anon + вход Supabase Auth,
--                                 права раздаёт RLS по таблице staff.
--   server.mjs, bots.mjs        → service_role, RLS их не касается.
--   Телефоны участников         → НИКОГДА. Только через server.mjs.
--
-- Последнее — главная граница доверия, ровно та же, что сегодня даёт
-- PUBLIC_FILES: роль anon не имеет ни одной политики, поэтому анонимный
-- запрос к participants возвращает пустоту, даже если ключ утёк в
-- landing.html. Ключ anon в лендинге не нужен и его там быть не должно.

create extension if not exists pgcrypto;      -- gen_random_uuid()

-- ── 1. ПЕРСОНАЛ ───────────────────────────────────────────────────
--
-- Заменяет users.json с его salt/hash: пароли теперь дело Supabase Auth,
-- а здесь лежит только роль. Строка появляется вручную после того, как
-- организатор создан в Auth — самозапись запрещена, иначе любой, кто
-- зарегистрировался, стал бы вожатым.

-- email дублирует auth.users намеренно: политики не дают клиенту читать
-- схему auth, а штаб должен видеть, кто есть кто. Без него список
-- доступа выглядел бы как набор uuid.
create table if not exists staff (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  email      text not null default '',
  name       text not null default '',
  role       text not null default 'lead'
             check (role in ('admin','lead','desk','content')),
  off        boolean not null default false,
  created_at timestamptz not null default now()
);
alter table staff add column if not exists email text not null default '';

/* Лагерь не должен остаться без «главного»: без активного admin никто
   больше не сможет ни выдать роль, ни забрать — политика staff_write
   требует именно эту роль. Это блокировка панели, из которой нет выхода
   изнутри.

   Проверка стоит в базе, а не только в интерфейсе: запрос мимо панели
   обошёл бы кнопку, но не триггер. Отложенный (deferred) — потому что
   проверять надо итог транзакции: «сделали второго главным, себя
   разжаловали» должно проходить, а построчная проверка спорила бы с
   порядком строк внутри одного запроса.

   Пустая таблица разрешена: это состояние «доступ ещё не настроен».
   А вот первую строку придётся заводить с ролью admin — иначе получился
   бы штаб, которым никто не управляет. */
create or replace function staff_keep_admin() returns trigger
language plpgsql as $$
begin
  if exists (select 1 from staff)
     and not exists (select 1 from staff where role = 'admin' and not off) then
    raise exception 'нельзя оставить лагерь без активного «главного»';
  end if;
  return null;
end $$;

drop trigger if exists staff_keep_admin_trg on staff;
create constraint trigger staff_keep_admin_trg
  after insert or update or delete on staff
  deferrable initially deferred
  for each row execute function staff_keep_admin();

-- security definer: политика должна читать staff, не спрашивая политик
-- staff — иначе рекурсия. stable + пустой search_path против подмены.
create or replace function public.staff_role()
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select role from staff where user_id = auth.uid() and not off
$$;

create or replace function public.is_staff(p_roles text[] default null)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(
    (select case when p_roles is null then true else role = any(p_roles) end
       from staff where user_id = auth.uid() and not off),
    false)
$$;

-- ── 2. УЧАСТНИКИ ──────────────────────────────────────────────────
--
-- id остаётся коротким текстом, как в participants.json: его генерирует
-- клиент, и это единственный способ создать участника на стойке, когда
-- интернета нет. uuid от базы такого не позволяет.
--
-- phone_key и name_key — те же две функции, что в server.mjs (последние
-- 10 цифр номера; имя в нижнем регистре со свёрнутыми пробелами). Здесь
-- они вычисляемые, чтобы правило жило в одном месте, а не в трёх файлах.

create table if not exists participants (
  id         text primary key,
  name       text not null default '',
  role       text not null default 'guest' check (role in ('guest','team')),
  status     text not null default 'new'
             check (status in ('new','confirmed','arrived','left','cancelled')),
  phone      text not null default '',
  tg         text not null default '',
  tg_id      text,
  max_id     text,
  room       text not null default '',
  classes    text[] not null default '{}',     -- что вписал штаб руками
  fee        numeric(10,2) not null default 0,
  note       text not null default '',
  -- 'YYYY-MM-DD HH:MM' местного времени, как сейчас в JSON. Нарочно не
  -- timestamptz: на этот формат смотрят регулярки в reception.html, а
  -- лагерь живёт в одной зоне. ponytail: если появятся часовые пояса —
  -- переводить в timestamptz вместе с форматированием на клиенте.
  arrived_at text,
  phone_key  text generated always as (
               case when length(regexp_replace(phone, '\D', '', 'g')) >= 10
                    then right(regexp_replace(phone, '\D', '', 'g'), 10) end
             ) stored,
  name_key   text generated always as (
               lower(regexp_replace(btrim(name), '\s+', ' ', 'g'))
             ) stored,
  updated_at timestamptz not null default now()
);

create index if not exists participants_phone_key_idx on participants (phone_key);
create index if not exists participants_name_key_idx  on participants (name_key);
create index if not exists participants_classes_idx   on participants using gin (classes);
-- бот привязывает аккаунт к человеку: один аккаунт — один участник
create unique index if not exists participants_tg_id_idx  on participants (tg_id)  where tg_id  is not null;
create unique index if not exists participants_max_id_idx on participants (max_id) where max_id is not null;

-- ── 3. ВЗНОСЫ ─────────────────────────────────────────────────────
--
-- Отдельная таблица, а не массив в участнике, ровно из-за офлайна:
-- строка с id, придуманным на устройстве, доезжает идемпотентно —
-- повторная отправка натыкается на primary key и ничего не портит.
-- Массив в jsonb при двух писателях терял бы взносы: кто записал
-- последним, тот и прав. На денежном пути так нельзя.

create table if not exists payments (
  id             uuid primary key default gen_random_uuid(),
  participant_id text not null references participants(id) on delete cascade,
  at             text not null default '',      -- 'YYYY-MM-DD', как в JSON
  sum            numeric(10,2) not null,
  note           text not null default '',
  taken_by       uuid references auth.users(id),
  created_at     timestamptz not null default now()
);

create index if not exists payments_participant_idx on payments (participant_id);

-- Долги и «сколько внесено» — не поле, а сумма строк: денормализация
-- здесь означала бы ещё один способ разойтись с реальностью.
create or replace view participants_money as
  select p.id,
         p.fee,
         coalesce(sum(y.sum), 0)                          as paid,
         greatest(0, p.fee - coalesce(sum(y.sum), 0))     as debt
    from participants p
    left join payments y on y.participant_id = p.id
   group by p.id, p.fee;

-- ── 4. ЗАПИСИ НА МАСТЕР-КЛАССЫ ────────────────────────────────────
--
-- who — 'p:<10 цифр телефона>' или 'i:<id аккаунта бота>', как сегодня.
-- unique(who, cls) заменяет самодельное «отфильтровать и дописать»:
-- повторная запись на ту же группу теперь невозможна на уровне базы,
-- а не на уровне аккуратности кода.

create table if not exists signups (
  id       uuid primary key default gen_random_uuid(),
  who      text not null,
  name     text not null,
  room     text not null default '',
  cls      text not null,                      -- 'Название · СР'
  at       timestamptz not null default now(),
  name_key text generated always as (
             lower(regexp_replace(btrim(name), '\s+', ' ', 'g'))
           ) stored,
  unique (who, cls)
);

create index if not exists signups_cls_idx on signups (cls);

-- ── 5. СОДЕРЖИМОЕ ЛАГЕРЯ ──────────────────────────────────────────
--
-- Тот самый блок CAMP из landing.html, одной строкой-документом.
-- Дробить его на таблицы дней, событий и текстов смысла нет: админка
-- правит его целиком и целиком же вклеивает в лендинг.
--
-- Тип json, а НЕ jsonb, намеренно: jsonb пересортировал бы ключи, и
-- каждое сохранение давало бы огромный diff landing.html — а он у вас
-- едет через GitHub. json хранит текст как есть.

create table if not exists camp_content (
  id         int primary key default 1 check (id = 1),
  doc        json not null,
  version    text not null default '',
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id)
);

-- Версия — то же, чем сегодня служит sha256 от литерала: телефон
-- сравнивает строку и перерисовывается, только если она сменилась.
-- Считаем в базе, чтобы клиент не мог соврать и не мог забыть.
create or replace function camp_stamp() returns trigger
language plpgsql as $$
begin
  new.version    := left(md5(new.doc::text), 12);
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists camp_content_stamp on camp_content;
create trigger camp_content_stamp before insert or update on camp_content
  for each row execute function camp_stamp();

-- ── 6. КОМНАТЫ И БОТЫ ─────────────────────────────────────────────

create table if not exists rooms (              -- бывший rooms.json
  room text primary key,
  hint text not null default ''
);

create table if not exists bot_links (          -- бывший bots.json
  account        text primary key,              -- 'tg:12345' / 'max:678'
  participant_id text references participants(id) on delete set null,
  phone_key      text,
  linked_at      timestamptz not null default now()
);

-- Токены ботов. Отдельная таблица с политикой только для admin: это
-- единственное, что нельзя показывать даже вожатому.
create table if not exists integrations (
  id   int primary key default 1 check (id = 1),
  doc  jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

-- ── 7. updated_at ─────────────────────────────────────────────────

create or replace function touch_updated_at() returns trigger
language plpgsql as $$
begin new.updated_at := now(); return new; end $$;

drop trigger if exists participants_touch on participants;
create trigger participants_touch before update on participants
  for each row execute function touch_updated_at();

drop trigger if exists integrations_touch on integrations;
create trigger integrations_touch before update on integrations
  for each row execute function touch_updated_at();

-- ── 8. МЕСТА В ГРУППАХ ────────────────────────────────────────────
--
-- Правило занятости повторяет takenOf() из server.mjs дословно:
-- считаем РАЗНЫХ людей по имени, объединяя записи с телефонов и то,
-- что штаб вписал руками. Иначе один человек занял бы два места.
--
-- Безымянный участник остаётся отдельной единицей (coalesce на id):
-- в JSON-версии он тоже считался отдельно, и схлопывать их в одного
-- значило бы тихо отдать чужие места.

create or replace function seats_taken(p_cls text)
returns int
language sql
stable
as $$
  select count(distinct k)::int from (
    select coalesce(nullif(name_key, ''), 'anon:' || id) as k
      from participants
     where status <> 'cancelled' and p_cls = any(classes)
    union
    select coalesce(nullif(name_key, ''), 'anon:' || id::text)
      from signups
     where cls = p_cls
  ) t
$$;

-- Ключ группы: 'Название · День', а без дня — просто название.
-- Тот же clsKey, что в server.mjs, ckey в админке и clsKey в лендинге.
create or replace function camp_classes()
returns table (cls text, cap int)
language sql
stable
as $$
  select case when coalesce(c->>'day', '') <> ''
              then (c->>'name') || ' · ' || (c->>'day')
              else coalesce(c->>'name', '') end,
         coalesce((c->>'cap')::int, 0)
    from camp_content,
         lateral jsonb_array_elements((doc::jsonb) -> 'classes') c
   where camp_content.id = 1
     and (doc::jsonb) -> 'classes' is not null
$$;

-- {'Музыка · СР': {taken: 3, cap: 12}, …} — ровно то, что сегодня
-- отдаёт GET /seats, чтобы лендинг не пришлось переучивать.
create or replace function seats()
returns jsonb
language sql
stable
as $$
  select coalesce(jsonb_object_agg(cls, jsonb_build_object(
           'taken', seats_taken(cls), 'cap', cap)), '{}'::jsonb)
    from camp_classes()
$$;

-- ── 9. ЗАПИСЬ НА МАСТЕР-КЛАСС ─────────────────────────────────────
--
-- Здесь лежит то, чего в файловой версии не могло быть в принципе:
-- проверка лимита и вставка в ОДНОЙ транзакции. Раньше между «посчитали
-- занятые места» и «записали» помещался чужой запрос — на 12 мест могло
-- прийти 13 человек. Теперь advisory-блокировка на ключ группы
-- выстраивает одновременные записи в очередь: ждут только те, кто лезет
-- в одну и ту же группу.
--
-- security definer: телефон приходит через server.mjs под service_role,
-- но функция должна одинаково работать и под персоналом.

create or replace function claim_seat(
  p_who  text,
  p_name text,
  p_room text default '',
  p_cls  text default '',
  p_off  boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_cap   int;
  v_taken int;
begin
  if coalesce(p_who, '') = '' or coalesce(p_cls, '') = '' then
    return jsonb_build_object('ok', false, 'error', 'bad');
  end if;

  if p_off then                                 -- отмена: лимит не при чём
    delete from signups where who = p_who and cls = p_cls;
    return jsonb_build_object('ok', true, 'off', true, 'seats', seats());
  end if;

  if coalesce(p_name, '') = '' then
    return jsonb_build_object('ok', false, 'error', 'bad');
  end if;

  perform pg_advisory_xact_lock(hashtext(p_cls));

  select cap into v_cap from camp_classes() where cls = p_cls;
  if v_cap is null then                         -- группы нет в лендинге
    return jsonb_build_object('ok', false, 'error', 'no_class');
  end if;

  -- уже записан — считаем успехом, чтобы повтор из офлайн-очереди
  -- не превращался в ошибку
  if exists (select 1 from signups where who = p_who and cls = p_cls) then
    return jsonb_build_object('ok', true, 'dup', true, 'seats', seats());
  end if;

  if v_cap > 0 then
    v_taken := seats_taken(p_cls);
    if v_taken >= v_cap then
      return jsonb_build_object('ok', false, 'error', 'full',
                                'taken', v_taken, 'cap', v_cap);
    end if;
  end if;

  insert into signups (who, name, room, cls)
  values (p_who, p_name, coalesce(p_room, ''), p_cls);

  return jsonb_build_object('ok', true, 'seats', seats());
end $$;

-- ── 10. «КТО Я И КУДА ЗАПИСАН» ────────────────────────────────────
--
-- Телефон присылает номер, участника находит база. Наружу уходит
-- только он сам: имя, комната, свои записи и то, что вписал штаб.
-- Список участников не покидает базу — это то же свойство, что и в
-- POST /me сегодня, просто теперь оно записано в SQL.

create or replace function whoami(p_phone text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_key  text;
  v_p    participants;
  v_who  text;
  v_mine text[];
begin
  v_key := case when length(regexp_replace(coalesce(p_phone,''), '\D', '', 'g')) >= 10
                then right(regexp_replace(p_phone, '\D', '', 'g'), 10) end;
  if v_key is null then
    return jsonb_build_object('ok', false, 'error', 'bad');
  end if;

  select * into v_p from participants
   where phone_key = v_key and status <> 'cancelled' limit 1;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'not_found');
  end if;

  v_who := 'p:' || v_key;
  select coalesce(array_agg(cls), '{}') into v_mine
    from signups where who = v_who;

  return jsonb_build_object(
    'ok',     true,
    'name',   v_p.name,
    'room',   v_p.room,
    'mine',   v_mine,
    -- записи штаба: их участник снять не может, это не его запись
    'locked', (select coalesce(array_agg(c), '{}')
                 from unnest(v_p.classes) c where not (c = any(v_mine))),
    'seats',  seats());
end $$;

-- ── 11. ГРАНИЦА ДОСТУПА (RLS) ─────────────────────────────────────
--
-- Включаем везде. Роль anon не получает НИ ОДНОЙ политики: это и есть
-- SQL-версия белого списка PUBLIC_FILES. service_role политики
-- обходит по определению — под ним ходят server.mjs и bots.mjs.

alter table staff        enable row level security;
alter table participants enable row level security;
alter table payments     enable row level security;
alter table signups      enable row level security;
alter table camp_content enable row level security;
alter table rooms        enable row level security;
alter table bot_links    enable row level security;
alter table integrations enable row level security;

-- staff: себя видно всем сотрудникам, менять — только главному
drop policy if exists staff_read  on staff;
drop policy if exists staff_write on staff;
create policy staff_read  on staff for select to authenticated using (is_staff());
create policy staff_write on staff for all    to authenticated
  using (is_staff(array['admin'])) with check (is_staff(array['admin']));

-- Участники: главный, стойка и вожатый. Редактор страницы (content)
-- персональных данных не видит ВООВЩЕ — не только не правит. Ему нужны
-- расписание и тексты, а телефоны и деньги к его работе не относятся:
-- меньше прав — меньше того, что утечёт вместе с его паролем.
drop policy if exists participants_read  on participants;
drop policy if exists participants_write on participants;
create policy participants_read  on participants for select to authenticated
  using (is_staff(array['admin','desk','lead']));
create policy participants_write on participants for all to authenticated
  using (is_staff(array['admin','desk','lead']))
  with check (is_staff(array['admin','desk','lead']));

-- взносы: видит тот же круг, что и участников; принимает стойка
drop policy if exists payments_read   on payments;
drop policy if exists payments_insert on payments;
drop policy if exists payments_delete on payments;
create policy payments_read   on payments for select to authenticated
  using (is_staff(array['admin','desk','lead']));
create policy payments_insert on payments for insert to authenticated
  with check (is_staff(array['admin','desk']));
create policy payments_delete on payments for delete to authenticated
  using (is_staff(array['admin','desk']));

-- записи на мастер-классы: штаб смотрит и может снять/вписать руками
drop policy if exists signups_read  on signups;
drop policy if exists signups_write on signups;
create policy signups_read  on signups for select to authenticated using (is_staff());
create policy signups_write on signups for all to authenticated
  using (is_staff(array['admin','desk','lead']))
  with check (is_staff(array['admin','desk','lead']));

-- содержимое лагеря: читает весь штаб, правят главный и редактор
drop policy if exists camp_read  on camp_content;
drop policy if exists camp_write on camp_content;
create policy camp_read  on camp_content for select to authenticated using (is_staff());
create policy camp_write on camp_content for all to authenticated
  using (is_staff(array['admin','content']))
  with check (is_staff(array['admin','content']));

drop policy if exists rooms_read  on rooms;
drop policy if exists rooms_write on rooms;
create policy rooms_read  on rooms for select to authenticated using (is_staff());
create policy rooms_write on rooms for all to authenticated
  using (is_staff(array['admin','content'])) with check (is_staff(array['admin','content']));

drop policy if exists bot_links_read on bot_links;
create policy bot_links_read on bot_links for select to authenticated using (is_staff());

-- токены ботов: только главный, и никто больше
drop policy if exists integrations_admin on integrations;
create policy integrations_admin on integrations for all to authenticated
  using (is_staff(array['admin'])) with check (is_staff(array['admin']));

-- ── 12. ПРАВА НА ФУНКЦИИ ──────────────────────────────────────────
--
-- claim_seat и whoami — security definer, то есть обходят RLS. Дать их
-- роли anon значило бы открыть интернету оракул «есть ли такой номер».
-- Поэтому: отзываем у anon и оставляем персоналу и service_role.

revoke all on function claim_seat(text,text,text,text,boolean) from anon, public;
revoke all on function whoami(text)                            from anon, public;
grant execute on function claim_seat(text,text,text,text,boolean) to authenticated, service_role;
grant execute on function whoami(text)                            to authenticated, service_role;
grant execute on function seats()                                 to authenticated, service_role;
grant execute on function seats_taken(text)                       to authenticated, service_role;
grant execute on function camp_classes()                          to authenticated, service_role;

-- ── 13. ПЕРВЫЙ ЗАПУСК ─────────────────────────────────────────────
-- Пустой документ лагеря, чтобы seats() не спотыкался до первого
-- сохранения из админки.
insert into camp_content (id, doc) values (1, '{"classes":[]}'::json)
  on conflict (id) do nothing;
insert into integrations (id) values (1) on conflict (id) do nothing;
