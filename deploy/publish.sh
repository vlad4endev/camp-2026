#!/bin/bash
# Публикация на camp.offline-tambov.ru и забор записей обратно.
#
#   ./deploy/publish.sh            — выложить лендинг и участников, забрать записи
#   ./deploy/publish.sh pull       — только забрать записи
#
# Адрес сервера можно переопределить: CAMP_HOST=camp@1.2.3.4 ./deploy/publish.sh
set -euo pipefail
cd "$(dirname "$0")/.."

HOST=${CAMP_HOST:-root@camp.offline-tambov.ru}
DIR=${CAMP_DIR:-/srv/camp}

pull(){
  # Записи с телефонов копятся на сервере — админка читает их отсюда.
  rsync -az "$HOST:$DIR/signups.json" ./signups.json && echo "  забрал signups.json"
}

if [ "${1:-}" = "pull" ]; then pull; exit 0; fi

command -v node >/dev/null || { echo "нужен node"; exit 1; }
[ -f landing.html ] || { echo "нет landing.html — запускать из папки проекта"; exit 1; }

echo "Проверяю сервер перед выкладкой…"
node server.mjs --selftest >/dev/null || { echo "  selftest не прошёл, выкладка отменена"; exit 1; }
echo "  ok"

# Участники: на сервер уходит только то, что читают /me и /signup —
# имя, телефон, комната, записи, статус. Взносы, оплаты, заметки и всё
# остальное остаются на ноутбуке: серверу они не нужны ни для чего, а
# при взломе VPS утекло бы и это. Граница дешёвая, поэтому она есть.
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
node -e '
  const fs = require("fs");
  const src = fs.existsSync("participants.json")
    ? JSON.parse(fs.readFileSync("participants.json", "utf8")) : [];
  const thin = (Array.isArray(src) ? src : []).map(p => ({
    name: p.name || "", phone: p.phone || "", room: p.room || "",
    classes: Array.isArray(p.classes) ? p.classes : [], status: p.status || "",
  }));
  fs.writeFileSync(process.argv[1] + "/participants.json", JSON.stringify(thin, null, 2));
  console.error(`  участников на сервер: ${thin.length} (только имя, телефон, комната, записи)`);
' "$TMP"

# На сервер кладём ровно то, что он раздаёт, и сам server.mjs. Админки,
# users.json и приёмки там нет вообще — нечего защищать, если файла нет.
# Без --delete: он снёс бы на сервере signups.json, которого нет в списке
# источников, — то есть все записи с телефонов. Мусор в папке не страшен,
# наружу его всё равно не отдаст белый список.
rsync -az \
  landing.html sw.js manifest.webmanifest server.mjs icons deploy \
  "$TMP/participants.json" \
  "$HOST:$DIR/"

# chown: rsync пришёл под root, а сервис работает под camp
ssh "$HOST" "chown -R camp:camp $DIR; systemctl restart camp"
echo "  выложено, сервис перезапущен"
pull
echo
echo "Проверьте: https://camp.offline-tambov.ru/"
