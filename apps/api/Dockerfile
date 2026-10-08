FROM node:22-alpine AS build

WORKDIR /app

COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
RUN npm ci --workspace @portal/api --ignore-scripts

COPY apps/api apps/api
# db:generate обязателен до tsc: без сгенерированного клиента @prisma/client
# не экспортирует PrismaClient и сборка падает. На уровне корня это делает
# скрипт build, но здесь вызывается сборка воркспейса напрямую.
RUN npm run db:generate --workspace @portal/api \
    && npm run build --workspace @portal/api \
    && npm run build:scripts --workspace @portal/api

FROM node:22-alpine AS runtime

ENV NODE_ENV=production
WORKDIR /app

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/apps/api/dist ./dist
COPY --from=build /app/apps/api/package.json ./package.json
COPY --from=build /app/apps/api/prisma ./prisma
# Сгенерированный клиент лежит в корневом node_modules, а не в apps/api:
# prisma generate пишет его на уровень npm workspaces. Копировать нечего —
# он уже приехал вместе с node_modules. Путь apps/api/node_modules/.prisma
# в старом Dockerfile не существовал, и сборка падала.

RUN apk add --no-cache openssl

# Контейнер работает не от root: при компрометации процесса атакующий получает
# внутри контейнера только права непривилегированного пользователя. API ничего
# не пишет на диск, поэтому chown нужен только для владельца каталога.
RUN chown -R node:node /app
USER node

EXPOSE 4000

CMD ["node", "dist/server.js"]
