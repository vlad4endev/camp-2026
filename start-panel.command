#!/bin/bash
# Запуск штаба: поднимает server.mjs и открывает панель в браузере.
# Именно этот сервер, а не любой другой: в нём белый список, который
# не отдаёт в лагерную Wi-Fi ни админку, ни users.json, ни участников.
cd "$(dirname "$0")"

if [ ! -f server.mjs ]; then
  echo "Рядом нет server.mjs — запускать нечего."
  read -p "Enter, чтобы закрыть"; exit 1
fi
if ! command -v node >/dev/null 2>&1; then
  echo "Не установлен Node.js — server.mjs без него не запустится."
  read -p "Enter, чтобы закрыть"; exit 1
fi

PORT=8000
node server.mjs $PORT &
SRV=$!
trap 'kill $SRV 2>/dev/null' EXIT
sleep 1
open "http://localhost:$PORT/admin.html"
echo
echo "  Штаб:    http://localhost:$PORT/admin.html"
echo "  Логин:   admin"
echo
echo "  Не закрывайте это окно, пока работаете. Ctrl+C — остановить."
wait $SRV
