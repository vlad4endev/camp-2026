# Деплой на camp.offline-tambov.ru

## Что где живёт

Проект намеренно разъезжается на две половины, и это не неудобство, а
граница безопасности:

| | Ноутбук организатора | Сервер (домен) |
|---|---|---|
| `landing.html` | правится в админке | раздаётся участникам |
| `admin.html`, `reception.html` | работают | **нет файла вообще** |
| `users.json` (логины) | лежит | **нет файла вообще** |
| `participants.json` | полные карточки | только имя, телефон, комната, записи |
| `signups.json` | забирается с сервера | копится от телефонов |

Админку нельзя перенести на сервер даже при желании: она пишет файлы
через File System Access API — то есть в папку **на той машине, где
открыта**. На сервере это ничего не значит. Её вход (PBKDF2, 120 000
итераций) — второй слой поверх границы, а не замена ей.

## Как устроена выкладка

```
ноутбук ──git push──> GitHub ──git pull (каждые 2 мин)──> сервер
   │                                                         ▲
   └──────────── participants.json (rsync, напрямую) ─────────┘
```

Код едет через GitHub. Участники — напрямую: в публичном репозитории им
не место, там телефоны и комнаты. Записи с телефонов забираются обратно
тем же rsync.

Сервер тянет сам, а не GitHub заходит по SSH. Репозиторий публичный,
поэтому `git pull` не требует никаких секретов — а схема с Actions
потребовала бы держать SSH-ключ к серверу в GitHub Secrets, то есть взлом
аккаунта GitHub означал бы root здесь.

Рабочая копия и раздаваемая папка разделены намеренно:

| | | |
|---|---|---|
| `/srv/camp-src` | клон репозитория | тут лежит и `admin.html`, но он никуда не раздаётся |
| `/srv/camp` | что раздаёт сервер | только лендинг, воркер, манифест, иконки, `server.mjs` |

Админки, `users.json` и `integrations.json` с токенами ботов в `/srv/camp`
нет вообще. «Файла нет» — граница надёжнее любого белого списка.

## Первая установка

Нужен **Node 20.11 или новее**: `server.mjs` использует
`import.meta.dirname`. В Debian 12 и Ubuntu 24.04 `apt install nodejs`
ставит 18.x — сервер откажется стартовать и скажет об этом. Поэтому Node
берём из NodeSource, а не из системного репозитория.

```bash
# на сервере, под root
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt install -y nodejs nginx certbot python3-certbot-nginx git rsync
node -v                                   # должно быть v22.x, не v18
# --group обязателен: без него adduser --system кладёт camp в nogroup,
# группы camp не появляется, и chown camp:camp падает — а следом за ним
# каждая выкладка, потому что pull.sh делает install -o camp -g camp
adduser --system --group --home /srv/camp --shell /bin/bash camp
mkdir -p /srv/camp && chown -R camp:camp /srv/camp
git clone https://github.com/vlad4endev/camp-2026 /srv/camp-src
```

Сервис и таймер выкладки:

```bash
cp /srv/camp-src/deploy/camp.service      /etc/systemd/system/
cp /srv/camp-src/deploy/camp-pull.service /etc/systemd/system/
cp /srv/camp-src/deploy/camp-pull.timer   /etc/systemd/system/
systemctl daemon-reload
systemctl enable camp
/srv/camp-src/deploy/pull.sh              # первая выкладка, поднимет camp
systemctl enable --now camp-pull.timer
```

`pull.sh` сам поймёт, что запущен впервые: в `/srv/camp` ещё нет лендинга.
Дальше он выкладывает только при новом коммите в `main`.

Прокси и сертификат. `A`-запись `camp` → IP сервера должна быть
**до** этого шага: certbot проверяет домен по HTTP-01, то есть Let's
Encrypt должен достучаться до этого сервера по имени.

```bash
cp /srv/camp-src/deploy/nginx.conf /etc/nginx/sites-available/camp.offline-tambov.ru
ln -sf /etc/nginx/sites-available/camp.offline-tambov.ru /etc/nginx/sites-enabled/
rm -f /etc/nginx/sites-enabled/default      # чтобы наш server_name стал основным
nginx -t && systemctl reload nginx          # пройдёт: TLS в конфиге ещё нет
certbot --nginx -d camp.offline-tambov.ru   # допишет 443, ssl_* и редирект с 80
nginx -t && systemctl reload nginx
```

Конфиг лежит без TLS намеренно: объявить `listen 443 ssl` заранее нельзя —
`nginx -t` упал бы на отсутствующем сертификате, а certbot прогоняет
`nginx -t` перед работой и отказался бы стартовать.

**В `nginx.conf` только ASCII.** Это единственный файл проекта с
английскими комментариями: плагин `certbot --nginx` парсит все конфиги
nginx, и кириллица в них роняет его с `UnicodeDecodeError`. Сломался бы не
только выпуск сертификата, но и `certbot renew` через 90 дней — молча.

Участники (с ноутбука, после того как сервер поднялся):

```bash
./deploy/publish.sh data
```

## Проверка, что граница держит

После установки — обязательно, это главный риск деплоя:

```bash
curl -sI https://camp.offline-tambov.ru/                     | head -1   # 200
curl -so /dev/null -w '%{http_code}\n' https://camp.offline-tambov.ru/admin.html         # 404
curl -so /dev/null -w '%{http_code}\n' https://camp.offline-tambov.ru/users.json         # 404
curl -so /dev/null -w '%{http_code}\n' https://camp.offline-tambov.ru/participants.json  # 404
curl -so /dev/null -w '%{http_code}\n' https://camp.offline-tambov.ru/signups.json       # 404
```

Если `admin.html` отдаёт 200 — забыт `CAMP_PUBLIC=1`. Без него server.mjs
считает каждый запрос из-за nginx запросом организатора: nginx стоит на той
же машине, и все соединения приходят с 127.0.0.1. Проверяется в selftest
(`на домене loopback привилегий не даёт`).

## Повседневная работа

```bash
./deploy/publish.sh        # запушить лендинг, обновить участников, забрать записи
./deploy/publish.sh code   # только код: коммит landing.html и push
./deploy/publish.sh data   # только участники и записи
./deploy/publish.sh pull   # только забрать записи
```

Правки лендинга доезжают до сервера в течение двух минут — таймер сам
подтянет коммит. Заходить на сервер для выкладки больше не нужно.

Что происходит на сервере — видно в журнале:

```bash
ssh root@camp.offline-tambov.ru 'journalctl -u camp-pull -n 30 --no-pager'
```

Выложить принудительно, не дожидаясь таймера:

```bash
ssh root@camp.offline-tambov.ru '/srv/camp-src/deploy/pull.sh --force'
```

Кэш на телефонах обновляется сам: версия в `sw.js` считается из хэша
`landing.html`, менять её руками не нужно.

## Боты

Ставятся на тот же сервер, рядом:

```bash
TG_TOKEN=… MAX_TOKEN=… CAMP_PORT=8000 node bots.mjs
```

Они ходят на `http://127.0.0.1:8000/signup` — то есть внутрь, минуя nginx
и его лимиты. Так и надо: бот уже знает, кто к нему пришёл.

## Чего здесь нет

- **Синхронизации участников в обе стороны.** `publish.sh data`
  перезаписывает серверную копию. Правьте участников только в админке.
- **Откатов через GitHub.** Сервер всегда выкладывает `origin/main`.
  Чтобы откатиться, нужен `git revert` и push — сервер подтянет откат
  как обычный коммит. Ручного «вернуть предыдущую версию» на сервере нет:
  сломанный код туда не попадёт, его отсекает selftest в `pull.sh`.
- **Приватного репозитория.** `git clone` идёт без секретов именно потому,
  что репозиторий публичный. Сделаете приватным — понадобится deploy key
  на сервере (`ssh-keygen`, публичная часть в Settings → Deploy keys) и
  адрес `git@github.com:vlad4endev/camp-2026.git`.
- **Бэкапов сервера.** `backups/` на сервере наполняется снимками
  участников, но никуда не уезжает. Настройте `restic`/`borg`, если записи
  на мастер-классы важны как единственная копия.
