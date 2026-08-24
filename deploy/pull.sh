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
git fetch --quiet origin main

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

# Только раздаваемое плюс сам сервер. participants.json и signups.json
# в /srv/camp не трогаем: они приезжают с ноутбука и копятся от телефонов.
install -m644 -o camp -g camp landing.html sw.js manifest.webmanifest server.mjs "$APP/"
# --delete внутри icons/ и deploy/ безопасен: это папки только с кодом,
# живых данных в них нет. В корне $APP --delete не применяется никогда.
rsync -a --delete --chown=camp:camp icons deploy "$APP/"

systemctl restart camp
log "выложено, сервис перезапущен"
