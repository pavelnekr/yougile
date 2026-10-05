# DEPLOY.md

Развёртывание на отдельном Linux-сервере (Ubuntu/Debian) через Docker Compose.
Схема: nginx/Caddy на хосте принимает HTTPS и проксирует на контейнер веба,
веб отдаёт статику и проксирует `/api` на контейнер API. Postgres и Redis
наружу не выставлены.

## 1. Что нужно на сервере

- Docker Engine + Docker Compose Plugin v2
- nginx или Caddy для HTTPS (Let's Encrypt)
- Домен, который смотрит на IP сервера

## 2. Залить проект

```bash
git clone https://github.com/pavelnekr/yougile.git
cd yougile
```

## 3. Настроить `.env`

```bash
cp .env.example .env
openssl rand -hex 32        # JWT_SECRET
openssl rand -hex 32        # YOUGILE_TOKEN_ENCRYPTION_KEY
openssl rand -base64 24     # POSTGRES_PASSWORD
chmod 600 .env
nano .env
```
Что заполнить:

| Переменная | Значение |
|---|---|
| `WEB_ORIGIN` | `https://portal.example.com` — публичный адрес, без слэша на конце |
| `JWT_SECRET` | строка минимум 32 символа (`openssl rand -hex 32`) |
| `YOUGILE_TOKEN_ENCRYPTION_KEY` | отдельный ключ шифрования токенов в БД: ровно 64 hex-символа (`openssl rand -hex 32`) |
| `POSTGRES_PASSWORD` | длинный случайный пароль (`openssl rand -base64 24`) |
| `YOUGILE_API_URL` | `https://yougile.ru/api-v2` |
| `REGISTRATION_KEY` | ключ самостоятельной регистрации в портале. Пустое значение не ломает старт, но регистрация отвечает 503, и учётные записи приходится заводить `npm run user:create --workspace @portal/api` (в контейнере — `node dist/scripts/create-user.js`) |
| `WEB_PORT` | порт контейнера веба на хосте |

После создания первого администратора добавьте токен YouGile каждого сотрудника
в разделе «Учётные записи». Токен проверяется перед сохранением и шифруется
ключом `YOUGILE_TOKEN_ENCRYPTION_KEY`; значение токена после сохранения не
показывается. Храните этот ключ в резервной копии отдельно от Git и базы.
Не меняйте его, пока в БД есть зашифрованные токены: без исходного ключа их
нельзя расшифровать, а смена ключа приведёт к необходимости ввести токены заново.

**`DATABASE_URL` и `REDIS_URL` в `.env` для прода не трогайте.** В них
`localhost` — это для локальной разработки. Внутри контейнеров compose
собирает адреса сам, из `POSTGRES_DB`/`POSTGRES_USER`/`POSTGRES_PASSWORD`
и имени сервиса `postgres`. Если оставить пример как есть, API не достучится
до базы.

`WEB_PORT` — порт, который слушает контейнер веба. Если 80 уже занят вашим
nginx, поставьте `WEB_PORT=8080` и проксируйте на `127.0.0.1:8080`.

## 4. Собрать и запустить

```bash
docker compose -f docker-compose.prod.yml up -d --build
```

Порядок запуска compose выстроен сам:

1. `postgres` и `redis` поднимаются и ждут.healthcheck.
2. Служебный контейнер `migrate` выполняет `prisma migrate deploy` и завершается.
3. `api` стартует только после успешного `migrate` (`service_completed_successfully`).
4. `web` стартует после того, как `api` станет healthy.

Миграции накатываются автоматически на каждом запуске, отдельной командой
вызывать `prisma migrate` не нужно.

Назначение и снятие инженеров выполняются по одной площадке за раз. Если
YouGile отвечает HTTP 429, запрос повторяется через 60 секунд и продолжает
повторяться с таким интервалом до успешного ответа.

Проверить:

```bash
docker compose -f docker-compose.prod.yml ps
docker compose -f docker-compose.prod.yml logs migrate   # Applied N migrations
curl http://127.0.0.1:${WEB_PORT:-8080}/api/health
```

## 5. Первый администратор

Без пользователя вход не работает: все маршруты кроме `/api/auth/*`
и `/api/health` закрыты проверкой сессии.

```bash
docker compose -f docker-compose.prod.yml exec api \
  node dist/scripts/create-user.js pavel "НАДЁЖНЫЙ_ПАРОЛЬ" "Павел" ADMIN
```

Без аргументов скрипт спросит логин, пароль, имя и роль интерактивно —
удобнее для первого раза:

```bash
docker compose -f docker-compose.prod.yml exec api node dist/scripts/create-user.js
```

Роли: `ADMIN` (полный доступ) и `OPERATOR`. Тот же скрипт меняет пароль:
запустите его с существующим логином, старые сессии этого пользователя будут
завершены.

## 6. HTTPS

Пусть домен `portal.example.com`, веб слушает на хосте порт `8080`.

### Caddy (проще, сертификат сам)

```
# /etc/caddy/Caddyfile
portal.example.com {
    reverse_proxy 127.0.0.1:8080
}
```

```bash
systemctl reload caddy
```

### nginx

```nginx
server {
    listen 80;
    server_name portal.example.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl;
    http2 on;
    server_name portal.example.com;

    ssl_certificate     /etc/letsencrypt/live/portal.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/portal.example.com/privkey.pem;

    # Загрузка XLSX-планов идёт через POST, держим запас.
    client_max_body_size 12m;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        # Операции идут долго, не обрывать соединение.
        proxy_read_timeout 300s;
    }
}
```

Сертификат:

```bash
apt install certbot python3-certbot-nginx
certbot --nginx -d portal.example.com
```

Флаг `X-Forwarded-Proto` обязателен: по нему API решает, ставить ли в cookie
атрибут `secure`. Без него логин через HTTPS не сохранит сессию.

Файлы загрузок не проксируйте наружу — портал работает по cookie-сессии,
а не по токену в URL.

## 7. Обновление

```bash
cd yougile
git pull
docker compose -f docker-compose.prod.yml up -d --build
```

Миграции применятся сами. Откат миграций Prisma не делает автоматически —
сначала смотрите `docker compose -f docker-compose.prod.yml logs migrate`.

## 8. Бэкапы

Postgres живёт в volume `postgres-data`. Дамп:

```bash
docker compose -f docker-compose.prod.yml exec -T postgres \
  pg_dump -U portal yougile_portal | gzip > backup-$(date +%F).sql.gz
```

Логи и файлы загрузок в этом томе не хранятся, но секреты из `.env`
в бэкап не попадают — держите `.env` отдельно.

## 9. Если что-то пошло не так

| Симптом | Причина |
|---|---|
| `API не может подключиться к базе` | в `.env` остался `localhost` в `DATABASE_URL`; compose должен перекрывать его сам |
| `migrate` в статусе `Error` | нет `POSTGRES_PASSWORD` в `.env`, либо не применены изменения схемы |
| healthcheck `api` не проходит | смотрите `docker compose -f docker-compose.prod.yml logs api` |
| логин не сохраняет сессию | прокси не передаёт `X-Forwarded-Proto`, либо `WEB_ORIGIN` не совпадает с адресом в браузере |
| порт занят | поставьте `WEB_PORT=8080` в `.env` и перезапустите compose |