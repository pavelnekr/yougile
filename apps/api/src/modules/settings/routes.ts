import type { FastifyInstance } from "fastify";
import type { PrismaClient } from "@prisma/client";
import { commentTemplateSchema, commentTemplateTypeSchema } from "./schema.js";

const templates = [
  { type: "filter", label: "Фильтры", description: "Работы с фильтрами" },
  { type: "balancers", label: "Балансеры", description: "Обновление ПО балансировщиков" },
  { type: "bypasses", label: "Байпасы", description: "Работы с байпасами" },
  { type: "ehw", label: "EHW", description: "Работы по EHW" }
] as const;

const settingKey = (type: string) => `comment-template:${type}`;

export async function registerSettingsRoutes(app: FastifyInstance, prisma: PrismaClient) {
  app.get("/api/settings/comment-templates", async (_request, reply) => {
    try {
      const saved = await prisma.appSetting.findMany({
        where: { key: { in: templates.map(({ type }) => settingKey(type)) } }
      });
      const values = new Map(saved.map((setting) => [setting.key, setting]));
      const items = templates.map((template) => {
        const setting = values.get(settingKey(template.type));
        if (setting && typeof setting.value !== "string") {
          throw new Error(`Stored comment template "${template.type}" is not a string`);
        }
        return {
          ...template,
          value: setting?.value ?? "",
          updatedAt: setting?.updatedAt.toISOString() ?? null
        };
      });
      return { templates: items };
    } catch (error) {
      app.log.error({ err: error }, "Could not load comment templates");
      return reply.code(500).send({ error: "Не удалось загрузить шаблоны комментариев." });
    }
  });

  app.put<{ Params: { type: string } }>("/api/settings/comment-templates/:type", async (request, reply) => {
    const type = commentTemplateTypeSchema.safeParse(request.params.type);
    if (!type.success) return reply.code(404).send({ error: "Шаблон комментария не найден." });

    const input = commentTemplateSchema.safeParse(request.body);
    if (!input.success) return reply.code(400).send({ error: "Шаблон не должен превышать 10 000 символов." });

    try {
      const setting = await prisma.appSetting.upsert({
        where: { key: settingKey(type.data) },
        create: { key: settingKey(type.data), value: input.data.value },
        update: { value: input.data.value }
      });
      const template = templates.find((item) => item.type === type.data)!;
      return {
        template: {
          ...template,
          value: setting.value,
          updatedAt: setting.updatedAt.toISOString()
        }
      };
    } catch (error) {
      app.log.error({ err: error, templateType: type.data }, "Could not save comment template");
      return reply.code(500).send({ error: "Не удалось сохранить шаблон комментария." });
    }
  });
}
