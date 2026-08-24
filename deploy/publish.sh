#!/bin/bash
# Публикация правок из админки. Код уезжает через GitHub, участники —
# напрямую на сервер, потому что в публичный репозиторий их класть нельзя.
#
#   ./deploy/publish.sh            — запушить лендинг, обновить участников, забрать записи
#   ./deploy/publish.sh code       — только код (git push)
#   ./deploy/publish.sh data       — только участники и записи
#   ./deploy/publish.sh pull       — только забрать записи
#
# Сервер сам подтягивает main каждые 2 минуты (camp-pull.timer), поэтому
# заходить на него для выкладки кода больше не нужно.
set -euo pipefail
cd "$(dirname "$0")/.."

HOST=${CAMP_HOST:-root@camp.offline-tambov.ru}
DIR=${CAMP_DIR:-/srv/camp}
MODE=${1:-all}

# ── Код: через GitHub ─────────────────────────────────────────────
code(){
  node server.mjs --selftest >/dev/null || {
    echo "  selftest не прошёл — не пушу"; exit 1; }

  # Только landing.html: это единственный файл, который пишет панель.
  # admin.html и reception.html — исходники, их коммитит человек руками;
  # забирать сюда чужую незакоммиченную работу нельзя.
  if git diff --quiet -- landing.html; then
    echo "  код: правок в лендинге нет"
  else
    git add -- landing.html
    git commit -qm "Лендинг: правки из панели $(date '+%d.%m %H:%M')"
    echo "  код: закоммитил landing.html"
  fi

  if [ -n "$(git log '@{u}..HEAD' --oneline 2>/dev/null)" ]; then
    git push -q origin main
    echo "  код: запушен, сервер подтянет в течение 2 минут"
  else
    echo "  код: на сервере уже всё"
  fi
}

# ── Участники: напрямую, минуя GitHub ────────────────────────────
# На сервер уходит только то, что читают /me и /signup: имя, телефон,
# комната, записи, статус. Взносы, оплаты и заметки остаются на ноутбуке —
# серверу они не нужны, а при взломе VPS утекли бы и они.
data(){
  local tmp; tmp=$(mktemp -d); trap 'rm -rf "$tmp"' RETURN
  node -e '
    const fs = require("fs");
    const src = fs.existsSync("participants.json")
      ? JSON.parse(fs.readFileSync("participants.json", "utf8")) : [];
    const thin = (Array.isArray(src) ? src : []).map(p => ({
      name: p.name || "", phone: p.phone || "", room: p.room || "",
      classes: Array.isArray(p.classes) ? p.classes : [], status: p.status || "",
    }));
    fs.writeFileSync(process.argv[1] + "/participants.json", JSON.stringify(thin, null, 2));
    console.log(`  участники: ${thin.length} (имя, телефон, комната, записи)`);
  ' "$tmp"
  # Перезапуск не нужен: server.mjs читает participants.json на каждый запрос
  rsync -az "$tmp/participants.json" "$HOST:$DIR/participants.json"
  ssh "$HOST" "chown camp:camp $DIR/participants.json"
}

# Записи с телефонов копятся на сервере — админка читает их отсюда.
pull(){ rsync -az "$HOST:$DIR/signups.json" ./signups.json && echo "  записи: забрал signups.json"; }

case "$MODE" in
  code) code ;;
  data) data; pull ;;
  pull) pull ;;
  all)  code; data; pull ;;
  *)    echo "не знаю режим «$MODE»; бывают: code, data, pull или без аргумента"; exit 1 ;;
esac
echo
echo "Проверьте: https://camp.offline-tambov.ru/"
