import type { FastifyInstance } from "fastify";
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
        error: "Не удалось загрузить площадки из YouGile. Проверьте доступ к колонке плана."
      });
    }
  });
}
