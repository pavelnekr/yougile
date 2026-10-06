import "./env.js";
import cors from "@fastify/cors";
import Fastify from "fastify";
import { PrismaClient } from "@prisma/client";
import { Redis } from "ioredis";
import cookie from "@fastify/cookie";
import { config } from "./config.js";
import { closeOperationQueue } from "./jobs/queue.js";
import { createOperationWorker } from "./jobs/worker.js";
import { registerAssignmentRoutes } from "./modules/assignments/routes.js";
import { registerCommentRoutes } from "./modules/comments/routes.js";
import { registerImportRoutes } from "./modules/imports/routes.js";
import { registerSiteRoutes } from "./modules/sites/routes.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerSettingsRoutes } from "./modules/settings/routes.js";
import { registerHistoryRoutes } from "./modules/history/routes.js";
import { registerAuthRoutes } from "./modules/auth/routes.js";
import { registerAdminRoutes } from "./modules/admin/routes.js";
import { registerLogRoutes } from "./modules/logs/routes.js";
import { registerLogHooks, startLogRetention, stopLogRetention } from "./modules/logs/service.js";
import { requireSession } from "./modules/auth/service.js";

// trustProxy ровно на один хоп: API не выставлен наружу (порт не публикуется в
// docker-compose.prod.yml) и доступен только через nginx, который дописывает
// реальный адрес клиента в конец X-Forwarded-For. Без этой настройки request.ip
// у всех запросов совпадал бы с адресом контейнера nginx, и ограничение частоты
// попыток входа блокировало бы всех сотрудников разом.
//
// hop === 0 — это ближайший адрес цепочки, то есть сам nginx. Дальше адреса не
// доверяем: hop === 1 достаётся из X-Forwarded-For, который клиент может
// подделать, отправив заголовок сам. Доверять только правому элементу цепочки
// позволяет то, что nginx дописывает реальный адрес в конец, а не заменяет
// заголовок.
const app = Fastify({
  logger: true,
  trustProxy: (_address: string, hop: number) => hop === 0
});
const prisma = new PrismaClient();
const redis = new Redis(config.REDIS_URL, {
  maxRetriesPerRequest: 1,
  lazyConnect: true
});
const operationWorker = createOperationWorker(prisma);

await app.register(cors, {
  origin: config.WEB_ORIGIN,
  credentials: true
});
await app.register(cookie);

// Хук журнала ставится до регистрации маршрутов: Fastify запоминает список
// хуков в момент создания маршрута, и хук, добавленный позже, к уже
// созданным маршрутам не применится.
registerLogHooks(app, prisma);

// Защита добавляется до регистрации маршрутов, иначе хук не применится к уже
// созданным маршрутам в Fastify. Публичные пути перечислены явно.
const publicPaths = ["/api/auth/", "/api/health"];
app.addHook("preHandler", async (request, reply) => {
  if (publicPaths.some((path) => request.url.startsWith(path))) return;
  await requireSession(prisma)(request, reply);
});

await registerHealthRoutes(app, prisma, redis);
await registerAuthRoutes(app, prisma);
await registerSiteRoutes(app, prisma);
await registerAssignmentRoutes(app, prisma);
await registerCommentRoutes(app, prisma);
await registerImportRoutes(app, prisma);
await registerHistoryRoutes(app, prisma);
await registerSettingsRoutes(app, prisma);
await registerAdminRoutes(app, prisma);
await registerLogRoutes(app, prisma);

// Очистка старых записей журнала. Таймер гаснет вместе с сервером, иначе
// процесс не завершится: интервал живёт дольше, чем соединения.
startLogRetention(prisma);

app.addHook("onClose", async () => {
  stopLogRetention();
  await operationWorker.close();
  await closeOperationQueue();
  await prisma.$disconnect();
  redis.disconnect();
});

try {
  await app.listen({ port: config.API_PORT, host: "0.0.0.0" });
} catch (error) {
  app.log.error(error);
  await app.close();
  process.exitCode = 1;
}
