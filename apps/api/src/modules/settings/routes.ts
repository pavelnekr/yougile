import type { FastifyInstance } from "fastify";
import type { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { builtInCommentTemplateTypeSchema, commentTemplateSchema, createCommentTemplateSchema } from "./schema.js";

const templates = [
  { type: "filter", label: "Фильтры", description: "Работы с фильтрами" },
  { type: "balancers", label: "Балансеры", description: "Обновление ПО балансировщиков" },
  { type: "bypasses", label: "Байпасы", description: "Работы с байпасами" },
  { type: "ehw", label: "EHW", description: "Работы по EHW" }
] as const;

const settingKey = (type: string) => `comment-template:${type}`;
const customSettingPrefix = "comment-template:custom:";
const customTypePrefix = "custom-";

function customTemplateFromSetting(setting: { key: string; value: unknown; updatedAt: Date }) {
  const id = setting.key.slice(customSettingPrefix.length);
  if (!/^[0-9a-f-]{36}$/i.test(id) || !setting.value || typeof setting.value !== "object" || Array.isArray(setting.value)) {
    throw new Error("Stored custom comment template is invalid");
  }
  const value = setting.value as Record<string, unknown>;
  if (typeof value.label !== "string" || typeof value.value !== "string") {
    throw new Error("Stored custom comment template is invalid");
  }
  return {
    type: `${customTypePrefix}${id}`,
    workType: "other",
    label: value.label,
    description: "Дополнительный шаблон",
    isCustom: true,
    value: value.value,
    updatedAt: setting.updatedAt.toISOString()
  };
}

export async function registerSettingsRoutes(app: FastifyInstance, prisma: PrismaClient) {
  app.get("/api/settings/comment-templates", async (_request, reply) => {
    try {
      const [saved, customSaved] = await Promise.all([
        prisma.appSetting.findMany({
          where: { key: { in: templates.map(({ type }) => settingKey(type)) } }
        }),
        prisma.appSetting.findMany({
          where: { key: { startsWith: customSettingPrefix } },
          orderBy: { updatedAt: "asc" }
        })
      ]);
      const values = new Map(saved.map((setting) => [setting.key, setting]));
      const items = templates.map((template) => {
        const setting = values.get(settingKey(template.type));
        if (setting && typeof setting.value !== "string") {
          throw new Error(`Stored comment template "${template.type}" is not a string`);
        }
        return {
          ...template,
          workType: template.type,
          isCustom: false,
          value: setting?.value ?? "",
          updatedAt: setting?.updatedAt.toISOString() ?? null
        };
      });
      return { templates: [...items, ...customSaved.map(customTemplateFromSetting)] };
    } catch (error) {
      app.log.error({ err: error }, "Could not load comment templates");
      return reply.code(500).send({ error: "Не удалось загрузить шаблоны комментариев." });
    }
  });

  app.post("/api/settings/comment-templates", async (request, reply) => {
    const input = createCommentTemplateSchema.safeParse(request.body);
    if (!input.success) {
      return reply.code(400).send({ error: input.error.issues[0]?.message ?? "Некорректные данные шаблона." });
    }
    try {
      const id = randomUUID();
      const setting = await prisma.appSetting.create({
        data: {
          key: `${customSettingPrefix}${id}`,
          value: { label: input.data.label, value: input.data.value }
        }
      });
      return reply.code(201).send({ template: customTemplateFromSetting(setting) });
    } catch (error) {
      app.log.error({ err: error }, "Could not create custom comment template");
      return reply.code(500).send({ error: "Не удалось создать шаблон комментария." });
    }
  });

  app.put<{ Params: { type: string } }>("/api/settings/comment-templates/:type", async (request, reply) => {
    const input = commentTemplateSchema.safeParse(request.body);
    if (!input.success) return reply.code(400).send({ error: "Шаблон не должен превышать 10 000 символов." });

    const type = builtInCommentTemplateTypeSchema.safeParse(request.params.type);
    const customId = request.params.type.startsWith(customTypePrefix)
      ? request.params.type.slice(customTypePrefix.length)
      : null;
    if (!type.success && (!customId || !/^[0-9a-f-]{36}$/i.test(customId))) {
      return reply.code(404).send({ error: "Шаблон комментария не найден." });
    }

    try {
      if (!type.success && customId) {
        const key = `${customSettingPrefix}${customId}`;
        const existing = await prisma.appSetting.findUnique({ where: { key } });
        if (!existing) return reply.code(404).send({ error: "Шаблон комментария не найден." });
        const current = customTemplateFromSetting(existing);
        const setting = await prisma.appSetting.update({
          where: { key },
          data: { value: { label: current.label, value: input.data.value } }
        });
        return { template: customTemplateFromSetting(setting) };
      }

      if (type.success) {
        const setting = await prisma.appSetting.upsert({
          where: { key: settingKey(type.data) },
          create: { key: settingKey(type.data), value: input.data.value },
          update: { value: input.data.value }
        });
        const template = templates.find((item) => item.type === type.data)!;
        return {
          template: {
            ...template,
            workType: template.type,
            isCustom: false,
            value: setting.value,
            updatedAt: setting.updatedAt.toISOString()
          }
        };
      }
      return reply.code(404).send({ error: "Шаблон комментария не найден." });
    } catch (error) {
      app.log.error({ err: error, templateType: request.params.type }, "Could not save comment template");
      return reply.code(500).send({ error: "Не удалось сохранить шаблон комментария." });
    }
  });

  app.delete<{ Params: { type: string } }>("/api/settings/comment-templates/:type", async (request, reply) => {
    const customId = request.params.type.startsWith(customTypePrefix)
      ? request.params.type.slice(customTypePrefix.length)
      : null;
    if (!customId || !/^[0-9a-f-]{36}$/i.test(customId)) {
      return reply.code(404).send({ error: "Дополнительный шаблон не найден." });
    }
    try {
      const result = await prisma.appSetting.deleteMany({ where: { key: `${customSettingPrefix}${customId}` } });
      if (!result.count) return reply.code(404).send({ error: "Дополнительный шаблон не найден." });
      return reply.code(204).send();
    } catch (error) {
      app.log.error({ err: error, templateType: request.params.type }, "Could not delete custom comment template");
      return reply.code(500).send({ error: "Не удалось удалить дополнительный шаблон." });
    }
  });
}
