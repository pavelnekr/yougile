import type { FastifyInstance } from "fastify";
import { config } from "../../config.js";
import { YougileClient } from "../../integrations/yougile/client.js";
import { getPlannedSites } from "./service.js";

export async function registerSiteRoutes(app: FastifyInstance, yougile: YougileClient) {
  app.get("/api/sites/in-plan", async (_request, reply) => {
    try {
      const items = await getPlannedSites(yougile);
      return {
        items,
        count: items.length,
        updatedAt: new Date().toISOString()
      };
    } catch (error) {
      app.log.error({ err: error }, "Could not load planned sites from YouGile");
      return reply.code(502).send({
        // Отдельно от пустого токена: клиент в этом случае вообще не ходит в
        // сеть, и совет «проверьте колонку плана» уводил совсем не туда.
        error: config.YOUGILE_API_TOKEN
          ? "Не удалось загрузить площадки из YouGile. Проверьте доступ к колонке плана."
          : "Портал не подключён к YouGile: на сервере не задан YOUGILE_API_TOKEN."
      });
    }
  });
}
