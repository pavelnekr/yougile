# DEPLOY.md
Короткая инструкция по развёртыванию на отдельном Linux-сервере.

## 1. Что нужно на сервере
- Docker Engine + Docker Compose (Plugin v2)
- Git (опционально) или просто скопировать архив репозитория
- Открыть порт 80/443 (или выбранный WEB_PORT)

## 2. Клонировать/залить проект
```bash
git clone https://github.com/pavelnekr/yougile.git
cd yougile
```
Или загрузить архив и распаковать.

## 3. Настроить .env
Скопируйте пример и заполните реальные значения:
```bash
cp .env.example .env
nano .env
```
Обязательные переменные:
- `JWT_SECRET` — минимум 32 символа (любая случайная строка)
- `YOUGILE_API_URL` — https://yougile.ru/api-v2 (или ваш инстанс)
- `YOUGILE_API_TOKEN` — токен YouGile
- `DATABASE_URL` — можно оставить по умолчанию (использует postgres в compose)
- `REDIS_URL` — можно оставить по умолчанию
- `WEB_ORIGIN` — URL сайта (например https://portal.example.com). Если HTTPS за прокси (nginx/Cloudflare) — ставьте https://...

Для прода можно переопределить порты:
```env
WEB_PORT=80
# API_PORT можно не указывать (не торчит наружу)
```

## 4. Создать первого администратора
```bash
docker compose -f docker-compose.prod.yml run --rm api node dist/scripts/create-user.js pavel "НАДЁЖНЫЙ_ПАРОЛЬ_МИН_8" "Павел" ADMIN
# или через tsx в dev-окружении, но в контейнере dist уже собран? Лучше собрать сначала
```
Но сначала собрать образы. Альтернатива — создать через API после запуска (но API защищён). Проще: запустить миграции и создать пользователя одной командой после старта БД.

Либо запустить БД+redis, прогнать миграции, создать пользователя, потом всё остальное.

## 5. Собрать и запустить
```bash
docker compose -f docker-compose.prod.yml up -d --build
```

После старта:
- Веб: http://YOUR_SERVER_IP (или :${WEB_PORT})
- API торчит только во внутренней сети Docker (web проксирует /api)

## 6. Миграции и первый пользователь (один раз)
После первого запуска БД поднята. Прогнать миграции и создать пользователя:
```bash
# Миграции Prisma
docker compose -f docker-compose.prod.yml exec api npx prisma migrate deploy

# Создать администратора (интерактивно нельзя, передаём аргументы)
docker compose -f docker-compose.prod.yml exec api node scripts/create-user.js pavel "SuperStrongPass123!" "Павел" ADMIN
```
Но `scripts/create-user.ts` лежит в `src/`, в `dist/` его нет. Нужно либо копировать скрипты в Dockerfile, либо запускать через tsx? Или добавить копирование scripts в образ API.

Исправление в Dockerfile API: добавить копирование `apps/api/scripts` в `dist/scripts`? Или просто скопировать в `/app/scripts`.

Добавлю копирование скриптов в образ API (чтобы можно было создать пользователя в проде).

## 7. Обновление
```bash
git pull
docker compose -f docker-compose.prod.yml up -d --build
docker compose -f docker-compose.prod.yml exec api npx prisma migrate deploy
```

## 8. Рекомендации
- За HTTPS ставьте reverse-proxy (Traefik/Nginx/Cloudflare Tunnel). Тогда `WEB_ORIGIN` должен быть `https://...`, куки `secure` включатся автоматически.
- Не выставляйте порт 5432/6379 наружу, если сервер не в изолированной сети.
- Регулярно делайте бэкап Postgres (`postgres-data` volume).
```