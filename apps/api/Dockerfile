FROM node:20-alpine AS build

WORKDIR /app

COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN npm ci --workspace @portal/api --ignore-scripts

COPY apps/api apps/api
COPY packages/shared packages/shared
RUN npm run build --workspace @portal/api

FROM node:20-alpine AS runtime

ENV NODE_ENV=production
WORKDIR /app

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/apps/api/dist ./dist
COPY --from=build /app/apps/api/package.json ./package.json
COPY --from=build /app/apps/api/prisma ./prisma
COPY --from=build /app/apps/api/node_modules/.prisma ./node_modules/.prisma
# Скрипты для управления пользователями в продакшене
COPY --from=build /app/apps/api/scripts ./scripts

RUN apk add --no-cache openssl

EXPOSE 4000

CMD ["node", "dist/server.js"]
