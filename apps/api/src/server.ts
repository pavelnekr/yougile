import "./env.js";
import cors from "@fastify/cors";
import Fastify from "fastify";
import { PrismaClient } from "@prisma/client";
import { Redis } from "ioredis";
import { config } from "./config.js";
import { closeOperationQueue } from "./jobs/queue.js";
import { createOperationWorker } from "./jobs/worker.js";
import { registerAssignmentRoutes } from "./modules/assignments/routes.js";
import { YougileClient } from "./integrations/yougile/client.js";
import { registerImportRoutes } from "./modules/imports/routes.js";
import { registerSiteRoutes } from "./modules/sites/routes.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerSettingsRoutes } from "./modules/settings/routes.js";
import { registerHistoryRoutes } from "./modules/history/routes.js";

const app = Fastify({ logger: true });
const prisma = new PrismaClient();
const yougile = new YougileClient();
const redis = new Redis(config.REDIS_URL, {
  maxRetriesPerRequest: 1,
  lazyConnect: true
});
const operationWorker = createOperationWorker(prisma, yougile);

await app.register(cors, {
  origin: config.WEB_ORIGIN,
  credentials: true
});

await registerHealthRoutes(app, prisma, redis);
await registerSiteRoutes(app, yougile);
await registerAssignmentRoutes(app, prisma, yougile);
await registerImportRoutes(app, prisma, yougile);
await registerHistoryRoutes(app, prisma, yougile);
await registerSettingsRoutes(app, prisma);

app.addHook("onClose", async () => {
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
