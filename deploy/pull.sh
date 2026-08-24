#!/bin/bash
# Выкладка на сервере: тянет main из GitHub и переносит в /srv/camp то,
# что сервер реально раздаёт. Запускается таймером camp-pull.timer.
#
# Почему pull, а не push из GitHub Actions: репозиторий публичный, поэтому
# клонирование не требует никаких секретов. Схема «Actions заходит по SSH»
# потребовала бы держать ключ к серверу в GitHub Secrets — взлом аккаунта
# GitHub означал бы root здесь. Тут же красть нечего.
#
# Почему не просто `git pull` прямо в /srv/camp: в репозитории лежат
# admin.html, reception.html и старые копии лендинга. Серверу они не нужны,
# а «файла нет» — граница надёжнее любого белого списка. Поэтому рабочая
# копия отдельно, а в /srv/camp переносится только раздаваемое.
set -euo pipefail

SRC=${CAMP_SRC:-/srv/camp-src}
APP=${CAMP_DIR:-/srv/camp}
log(){ echo "[pull] $*"; }

cd "$SRC"

# Таймаут обязателен: без него подвисший fetch держал бы прогон вечно, а
# таймер каждые две минуты запускал бы следующий. Не ответил — молча ждём
# следующего тика, лагерь при этом работает на прошлой версии.
if ! timeout 60 git fetch --quiet origin main; then
  log "git fetch не ответил за 60 с — пропускаю этот прогон"
  exit 0
fi

# Обычный прогон: нового коммита нет — молча выходим.
# Но на свежем клоне HEAD уже равен origin/main, а в /srv/camp ещё пусто,
# поэтому первый запуск узнаём по отсутствию лендинга на месте.
# --force — переложить принудительно, когда файлы в /srv/camp испортились.
if [ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ] \
   && [ -f "$APP/landing.html" ] \
   && [ "${1:-}" != "--force" ]; then
  exit 0
fi

log "новый коммит: $(git log --oneline -1 origin/main)"
git reset --hard --quiet origin/main

# Ворота: сломанный сервер на живой лагерь не выкладываем. Проверяется
# здесь, а не только в GitHub Actions, — доверять надо тому, что рядом.
if ! node server.mjs --selftest >/tmp/camp-selftest.txt 2>&1; then
  log "SELFTEST НЕ ПРОШЁЛ — выкладка отменена, работает прошлая версия"
  grep 'ПЛОХО' /tmp/camp-selftest.txt || tail -5 /tmp/camp-selftest.txt
  exit 1
fi

# Код — из git. Панели тоже код: их правит человек, а не панель.
#
# .mjs и .js берём маской, а не списком имён: server.mjs импортирует
# соседний модуль, reception.html подключает camp-db.js, и следующий такой
# сосед по списку имён просто не доехал бы — сервер упал бы на
# ERR_MODULE_NOT_FOUND, а панель на 404 своего же скрипта. Список имён был
# ровно тем видом знания, которое устаревает молча.
# HTML остаётся списком имён, а не маской: рядом лежат landing.backup.html
# и landing.v1-selling.html — старые копии, которым на сервере делать
# нечего, а landing.html не код (см. ниже). Добавляете страницу — вписывайте
# сюда, иначе она молча не доедет.
install -m644 -o camp -g camp *.mjs *.js manifest.webmanifest \
                              enter.html admin.html reception.html "$APP/"

# landing.html СЮДА НЕ ВХОДИТ намеренно. Его правит штаб прямо на сервере,
# значит это уже не код, а живое состояние — как участники и записи. Ставим
# из репозитория ровно один раз, когда файла на сервере ещё нет; дальше
# git-версия остаётся образцом для нового лагеря, а не источником правды.
[ -f "$APP/landing.html" ] || install -m644 -o camp -g camp landing.html "$APP/"

# Пустой список участников при первом запуске: тогда /me и панель отвечают
# осмысленно с самого начала, а не «файла нет».
#
# Доступ здесь не заводится вообще: пароли держит Supabase Auth, роли —
# таблица staff. Файла с хэшами рядом с панелью больше нет, и заводить его
# нечем (deploy/mkuser.mjs удалён вместе с ним).
if [ ! -f "$APP/participants.json" ]; then
  echo '[]' > "$APP/participants.json"
  chown camp:camp "$APP/participants.json"
  log "создан пустой participants.json — доступ заводится в Supabase: аккаунт + строка в staff"
fi
# --delete внутри icons/ и deploy/ безопасен: это папки только с кодом,
# живых данных в них нет. В корне $APP --delete не применяется никогда.
rsync -a --delete --chown=camp:camp icons deploy "$APP/"

systemctl restart camp
log "выложено, сервис перезапущен"
