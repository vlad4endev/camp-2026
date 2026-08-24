#!/bin/bash
# Обмен с сервером. Штаб и ресепшен теперь живут на сервере и правят его
# файлы напрямую, поэтому источник правды — сервер, а не ноутбук.
#
#   ./deploy/publish.sh            — запушить код и забрать копию данных
#   ./deploy/publish.sh code       — только код (git push)
#   ./deploy/publish.sh pull       — только забрать копию данных с сервера
#   ./deploy/publish.sh seed       — залить участников и учётки на ПУСТОЙ сервер
#
# Сервер сам подтягивает main каждые 2 минуты (camp-pull.timer).
set -euo pipefail
cd "$(dirname "$0")/.."

HOST=${CAMP_HOST:-root@camp.offline-tambov.ru}
DIR=${CAMP_DIR:-/srv/camp}
MODE=${1:-all}

# ── Код: через GitHub ─────────────────────────────────────────────
code(){
  node server.mjs --selftest >/dev/null || {
    echo "  selftest не прошёл — не пушу"; exit 1; }

  if [ -n "$(git log '@{u}..HEAD' --oneline 2>/dev/null)" ]; then
    git push -q origin main
    echo "  код: запушен, сервер подтянет в течение 2 минут"
  else
    echo "  код: на сервере уже всё"
  fi
  # landing.html намеренно НЕ коммитим: его правит панель на сервере, и
  # коммит с ноутбука затёр бы правки штаба при следующей выкладке.
  if ! git diff --quiet -- landing.html; then
    echo "  внимание: landing.html правлен локально и не отправлен."
    echo "            Правьте лендинг в панели на домене, иначе правки разойдутся."
  fi
}

# ── Данные: копия с сервера на ноутбук ────────────────────────────
# Не синхронизация, а резервная копия. Сервер — источник правды: участников
# и лендинг правит панель на домене, записи копятся от телефонов.
pull(){
  for f in participants.json signups.json landing.html; do
    if rsync -az "$HOST:$DIR/$f" "./$f" 2>/dev/null; then
      echo "  забрал $f"
    else
      echo "  на сервере пока нет $f"
    fi
  done
}

# ── Первичное заполнение пустого сервера ──────────────────────────
# Полные карточки и учётки: панель на домене должна видеть взносы и оплаты,
# иначе ресепшен не сможет принимать деньги. Делать это ПОВТОРНО опасно —
# затрёт то, что штаб уже наработал на сервере, поэтому спрашиваем.
seed(){
  local have
  have=$(ssh "$HOST" "wc -c < $DIR/participants.json 2>/dev/null || echo 0")
  if [ "${have:-0}" -gt 4 ]; then
    echo "  На сервере уже есть участники ($have байт)."
    echo "  Заливка затрёт их. Если это действительно нужно — CAMP_FORCE_SEED=1"
    [ "${CAMP_FORCE_SEED:-}" = "1" ] || exit 1
  fi
  for f in participants.json users.json integrations.json; do
    [ -f "$f" ] || { echo "  нет $f — пропускаю"; continue; }
    rsync -az "$f" "$HOST:$DIR/$f"
    ssh "$HOST" "chown camp:camp $DIR/$f"
    echo "  залил $f"
  done
  echo "  Перезапуск не нужен: server.mjs читает эти файлы на каждый запрос."
}

case "$MODE" in
  code) code ;;
  pull) pull ;;
  seed) seed ;;
  all)  code; pull ;;
  *)    echo "не знаю режим «$MODE»; бывают: code, pull, seed или без аргумента"; exit 1 ;;
esac
echo
echo "  Лендинг:  https://camp.offline-tambov.ru/"
echo "  Штаб:     https://camp.offline-tambov.ru/admin/"
echo "  Ресепшен: https://camp.offline-tambov.ru/reseption/"
