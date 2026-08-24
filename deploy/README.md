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

## Первая установка

Нужен **Node 20.11 или новее**: `server.mjs` использует
`import.meta.dirname`. В Debian 12 и Ubuntu 24.04 `apt install nodejs`
ставит 18.x — сервер откажется стартовать и скажет об этом. Поэтому Node
берём из NodeSource, а не из системного репозитория.

```bash
# на сервере, под root
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt install -y nodejs nginx certbot python3-certbot-nginx rsync
node -v                                   # должно быть v22.x, не v18
adduser --system --home /srv/camp --shell /bin/bash camp
mkdir -p /srv/camp && chown camp:camp /srv/camp
```

Выложить файлы с ноутбука:

```bash
./deploy/publish.sh
```

Сервис и прокси:

```bash
# на сервере
cp /srv/camp/deploy/camp.service /etc/systemd/system/camp.service
systemctl enable --now camp
systemctl status camp            # должно быть «ПУБЛИЧНЫЙ РЕЖИМ»

cp /srv/camp/deploy/nginx.conf /etc/nginx/sites-available/camp.offline-tambov.ru
ln -s /etc/nginx/sites-available/camp.offline-tambov.ru /etc/nginx/sites-enabled/
certbot --nginx -d camp.offline-tambov.ru      # выпишет сертификат и допишет ssl_*
nginx -t && systemctl reload nginx
```

DNS: `A`-запись `camp` → IP сервера, до запуска certbot.

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
./deploy/publish.sh        # выложить правки лендинга, забрать записи
./deploy/publish.sh pull   # только забрать записи
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

- **Синхронизации в обе стороны.** `publish.sh` выкладывает лендинг и
  участников, забирает записи. Если править участников и на сервере, и на
  ноутбуке — выкладка перезапишет серверную копию. Правьте только в админке.
- **Бэкапов сервера.** `backups/` на сервере наполняется снимками
  участников, но никуда не уезжает. Настройте `restic`/`borg`, если записи
  на мастер-классы важны как единственная копия.
