# Деплой на camp.offline-tambov.ru

## Что где живёт

Штаб и ресепшен работают **по адресу домена** и правят файлы прямо на
сервере. Значит источник правды — сервер, а не ноутбук.

| | Ноутбук | Сервер |
|---|---|---|
| `landing.html` | образец для нового лагеря | **живая версия**, её правит штаб |
| `participants.json` | резервная копия | **живые карточки** целиком, со взносами |
| `users.json` | копия | **живая**, вход в панели |
| `integrations.json` | копия | **живой**, токены ботов |
| `signups.json` | резервная копия | копится от телефонов |
| `admin.html`, `reception.html` | код, правится руками | приезжает из git |

Ноутбук остаётся рабочим: `node server.mjs 8000` и панели на `localhost`
работают как раньше, по файлам в папке. Но это уже автономный режим на
случай «нет интернета», а не основной путь.

## Адреса

| | |
|---|---|
| https://camp.offline-tambov.ru/ | лендинг, участникам |
| https://camp.offline-tambov.ru/admin/ | штаб |
| https://camp.offline-tambov.ru/reseption/ | ресепшен |

У штаба и ресепшена **разные пароли и разные порты**. Разные пароли сами
по себе были бы косметикой: с паролем стойки открылся бы
`/reseption/admin.html`, потому что один порт отдаёт всё. Поэтому у каждой
панели свой список того, что за паролем видно:

| | Штаб (8001) | Стойка (8002) |
|---|---|---|
| `admin.html` | видит | **404** |
| `reception.html` | видит | видит |
| `participants.json` | читает и пишет | читает и пишет |
| `users.json` | читает и пишет | только читает (нужен для входа) |
| `landing.html` | читает и пишет | **404** |
| `integrations.json` (токены ботов) | читает и пишет | **404** |
| `signups.json` (записи на МК) | читает | **404** |

Пароль у стойки — это пароль человека, который принимает деньги, а не
человека, который правит расписание.

Поверх этого остаётся второй слой — вход внутри панели по `users.json`
с ролями, он же был и раньше.

## Как это устроено

```
                    ┌─ / ──────────── лендинг (порт 8000, белый список)
камп.домен ─ nginx ─┤
                    └─ /admin/ ────── Basic auth -> порт 8001 (всё + запись)
                       /reseption/

ноутбук ──git push──> GitHub ──git pull (2 мин)──> сервер   (только КОД)
ноутбук <──── rsync ──────────────────────────────  сервер   (копия ДАННЫХ)
```

`server.mjs` слушает три порта:

| Порт | Кто приходит | Что доступно |
|---|---|---|
| 8000 | весь интернет через nginx | белый список: лендинг, воркер, манифест, иконки, `/seats`, `/signup`, `/me` |
| 8001 | `/admin/` под своим паролем | всё, плюс `PUT` четырёх файлов |
| 8002 | `/reseption/` под своим паролем | ресепшен, участники, `users.json`; `PUT` только участников |

Оба непубличных порта слушают исключительно loopback. **Порт и есть
пропуск**: снаружи на каждый ведёт единственная дорога — своя `location` в
nginx под своим паролем. Заголовку («я прошёл авторизацию, я штаб») верить
не пришлось: порт из интернета подделать нельзя, заголовок — можно, а цена
ошибки здесь вся админка.

`PUT` разрешён для четырёх имён: `landing.html`, `participants.json`,
`users.json`, `integrations.json`. Всё остальное — 403. `server.mjs`,
`sw.js` и `bots.mjs` правит только человек через git: `PUT` туда означал бы
удалённое исполнение кода на сервере.

Сервер тянет код сам, а не GitHub заходит по SSH. Репозиторий публичный,
поэтому `git pull` не требует никаких секретов — а схема с Actions
потребовала бы держать SSH-ключ к серверу в GitHub Secrets, то есть взлом
аккаунта GitHub означал бы root здесь.

Рабочая копия и раздаваемая папка разделены намеренно:

| | | |
|---|---|---|
| `/srv/camp-src` | клон репозитория | тут лежат и старые копии лендинга |
| `/srv/camp` | что видит сервер | только нужное, плюс живые данные |


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

Пароль на панели. Это первый и главный слой: без него `/admin/` отдал бы
`users.json` и карточки участников любому, а вход внутри панели клиентский —
его обходят через инструменты разработчика.

Два файла — по одному на панель:

```bash
apt install -y apache2-utils
htpasswd -c /etc/nginx/camp-admin.htpasswd admin   # пароль штаба
htpasswd -c /etc/nginx/camp-desk.htpasswd  desk    # пароль стойки, другой
chmod 640 /etc/nginx/camp-admin.htpasswd /etc/nginx/camp-desk.htpasswd
chown root:www-data /etc/nginx/camp-admin.htpasswd /etc/nginx/camp-desk.htpasswd
nginx -t && systemctl reload nginx
```

Второго человека в тот же файл добавляют **без** `-c` — иначе файл
перезапишется и первый потеряет доступ:

```bash
htpasswd /etc/nginx/camp-desk.htpasswd anna
```

Участники и учётки — с ноутбука, один раз, на пустой сервер:

```bash
./deploy/publish.sh seed
```

Заливает полные карточки, `users.json` и `integrations.json`. Повторно
скрипт откажется: дальше правит панель на сервере, и повторная заливка
затёрла бы её работу.

## Проверка, что граница держит

После установки — обязательно, это главный риск деплоя.

Публичная сторона не отдаёт лишнего:

```bash
for p in "" admin.html users.json participants.json signups.json integrations.json server.mjs reception.html; do printf "%-22s %s\n" "/$p" "$(curl -so /dev/null -w '%{http_code}' https://camp.offline-tambov.ru/$p)"; done
```

`200` только на первой строке, дальше везде `404`.

Панели закрыты паролем — без него ничего, включая данные:

```bash
for p in admin/ reseption/ admin/users.json reseption/participants.json; do printf "%-28s %s\n" "/$p" "$(curl -so /dev/null -w '%{http_code}' https://camp.offline-tambov.ru/$p)"; done
```

Все четыре — `401`. Если хоть один `200`, гейт не работает: смотрите
`auth_basic_user_file` и существование обоих файлов `.htpasswd`.

Пароли разделены — это главная проверка этого раздела. Паролем стойки штаб
не открывается:

```bash
curl -so /dev/null -w 'стойкой в штаб: %{http_code} (ждём 401)\n' -u desk https://camp.offline-tambov.ru/admin/
```

И даже со своим паролем стойка не достаёт до файлов штаба:

```bash
for p in admin.html landing.html integrations.json signups.json; do printf "  стойка -> %-20s %s (ждём 404)\n" "$p" "$(curl -so /dev/null -w '%{http_code}' -u desk https://camp.offline-tambov.ru/reseption/$p)"; done
```

Свои панели каждым паролем открываются:

```bash
printf 'штаб: %s   стойка: %s\n' "$(curl -so /dev/null -w '%{http_code}' -u admin https://camp.offline-tambov.ru/admin/)" "$(curl -so /dev/null -w '%{http_code}' -u desk https://camp.offline-tambov.ru/reseption/)"
```

Оба `200`. Порт панели не должен торчать в интернет напрямую:

```bash
curl -s -m 5 -o /dev/null -w '%{http_code}\n' http://camp.offline-tambov.ru:8001/admin.html || echo "порт 8001 снаружи закрыт — так и надо"
```

Если `admin.html` отдаётся по публичному адресу — забыт `CAMP_PUBLIC=1`.
Без него `server.mjs` считает каждый запрос из-за nginx запросом
организатора: nginx стоит на той же машине, и все соединения приходят с
127.0.0.1. Проверяется в selftest (`на домене loopback привилегий не даёт`).


## Повседневная работа

Расписание, объявления, мастер-классы, участники, оплаты — всё в панели по
адресу домена. Сохранение уходит на сервер сразу, участники видят правки при
следующем открытии страницы: версия кэша в `sw.js` считается из хэша
лендинга и меняется сама.

Ноутбук нужен только для двух вещей.

Выложить правки кода:

```bash
./deploy/publish.sh code
```

Забрать резервную копию данных с сервера:

```bash
./deploy/publish.sh pull
```

Что происходит на сервере:

```bash
ssh root@camp.offline-tambov.ru 'journalctl -u camp-pull -n 30 --no-pager'
```

Выложить код принудительно, не дожидаясь таймера:

```bash
ssh root@camp.offline-tambov.ru '/srv/camp-src/deploy/pull.sh --force'
```


## Боты

Ставятся на тот же сервер, рядом:

```bash
TG_TOKEN=… MAX_TOKEN=… CAMP_PORT=8000 node bots.mjs
```

Они ходят на `http://127.0.0.1:8000/signup` — то есть внутрь, минуя nginx
и его лимиты. Так и надо: бот уже знает, кто к нему пришёл.

## Чего здесь нет

- **Синхронизации ноутбука и сервера.** Правьте в панели на домене. Локальная
  панель на `localhost` работает по файлам в папке и о сервере не знает: если
  править в обеих, версии разойдутся молча. `publish.sh pull` — это резервная
  копия, а не слияние.
- **`landing.html` из git.** Раз его правит панель на сервере, это уже живое
  состояние, а не код. `pull.sh` ставит его из репозитория **один раз**, когда
  файла ещё нет; дальше git-версия остаётся образцом для нового лагеря.
  Поэтому история правок лендинга живёт в `backups/` на сервере, а не в
  коммитах.
- **Больше двух ролей на уровне гейта.** Их две: штаб и стойка. Если
  понадобится третья (например «только смотреть»), это ещё один порт со
  своим списком в `server.mjs` и ещё одна `location` — механизм тот же,
  но руками. Роли внутри панели (`users.json`) остаются вторым слоем.
- **Откатов через GitHub.** Сервер всегда выкладывает `origin/main`. Чтобы
  откатить код, нужен `git revert` и push. Сломанный код туда не попадёт —
  его отсекает selftest в `pull.sh`.
- **Бэкапов сервера наружу.** `backups/` на сервере наполняется снимками
  участников и лендинга, но никуда не уезжает. `./deploy/publish.sh pull`
  забирает текущее состояние; для настоящих бэкапов настройте `restic`.
- **Приватного репозитория.** `git clone` идёт без секретов именно потому,
  что репозиторий публичный. Сделаете приватным — понадобится deploy key на
  сервере и адрес `git@github.com:vlad4endev/camp-2026.git`.
