#!/bin/bash
# Запуск панели: поднимает server.mjs и открывает страницу входа.
# Именно этот сервер, а не любой другой: в нём и белый список (в лагерную
# Wi-Fi не уходят ни панели, ни участники), и сама проверка входа —
# пароль сверяется здесь, а не в браузере.
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

# Открываем ДВЕРЬ, а не панель. Одна страница входа на всех: логин и
# пароль, а куда пустить — в штаб или на ресепшн — решает роль. Открывать
# сразу admin.html незачем: без входа он всё равно отправит сюда же.
open "http://localhost:$PORT/enter.html"
echo
echo "  Вход:    http://localhost:$PORT/enter.html"
echo "  Дальше   по роли: главный и вожатый — в штаб, регистратура — на ресепшн."
echo
echo "  Не закрывайте это окно, пока работаете. Ctrl+C — остановить."
wait $SRV
