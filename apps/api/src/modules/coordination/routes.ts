import type { FastifyInstance } from "fastify";
import { PortalRole, type PrismaClient } from "@prisma/client";
import { config } from "../../config.js";
import { previewRateLimit, rateLimitPerUser, sendLetterRateLimit } from "../auth/rate-limit.js";
import { requireRole } from "../auth/service.js";
import { recordLog } from "../logs/service.js";
import { mailRecipientsSchema, previewFieldsSchema, sendLetterSchema, smtpSettingsSchema } from "./schema.js";
import {
  buildLetterFromDocx,
  describeSendError,
  isSmtpConfigured,
  loadMailRecipients,
  loadSmtpSettings,
  saveMailRecipients,
  saveSmtpSettings,
  sendLetter,
  type SmtpSettings
} from "./service.js";

// Лимиты multipart для предпросмотра: глобальная регистрация в imports/routes.ts
// рассчитана на один XLSX-файл без полей (parts: 1, fields: 0), а здесь нужно
// DOCX + три поля формы. request.parts() принимает свои лимиты на запрос —
// они перекрывают глобальные, не меняя загрузку XLSX на других страницах.
const previewMultipartLimits = {
  fileSize: config.UPLOAD_MAX_BYTES,
  files: 1,
  fields: 8,
  parts: 10
};

/**
 * Раздел «Согласование/Оповещение»: предпросмотр письма по DOCX-плану
 * и отправка его по SMTP. Файл разбирается на сервере (mammoth), тема и тело
 * правятся оператором в предпросмотре, отправка — только по явному нажатию.
 * Список получателей и параметры SMTP живут в AppSetting и редактируются
 * в «Конфигурации портала» → «Оповещения».
 */
export async function registerCoordinationRoutes(app: FastifyInstance, prisma: PrismaClient) {
  const adminOnly = requireRole(PortalRole.ADMIN);

  app.get("/api/coordination/config", async (_request, reply) => {
    try {
      const [recipients, settings] = await Promise.all([
        loadMailRecipients(prisma),
        loadSmtpSettings(prisma)
      ]);
      return {
        recipients,
        smtpConfigured: isSmtpConfigured(settings),
        // Пароль в ответ не попадает — только флаг, что он задан.
        smtp: {
          host: settings.host,
          port: settings.port,
          user: settings.user,
          from: settings.from,
          passwordSet: settings.password.length > 0
        }
      };
    } catch (error) {
      app.log.error({ err: error }, "Could not read coordination config");
      return reply.code(500).send({ error: "Не удалось загрузить конфигурацию оповещений." });
    }
  });

  app.put("/api/coordination/recipients", { preHandler: adminOnly }, async (request, reply) => {
    const parsed = mailRecipientsSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "Проверьте список получателей." });
    }
    try {
      await saveMailRecipients(prisma, parsed.data.recipients);
    } catch (error) {
      app.log.error({ err: error }, "Could not save mail recipients");
      return reply.code(500).send({ error: "Не удалось сохранить получателей." });
    }
    app.log.warn(
      { actor: request.sessionUser?.login, count: parsed.data.recipients.length },
      "Mail recipients updated via portal config"
    );
    return { recipients: parsed.data.recipients };
  });

  app.put("/api/coordination/smtp", { preHandler: adminOnly }, async (request, reply) => {
    const parsed = smtpSettingsSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "Проверьте параметры SMTP." });
    }
    let savedPasswordSet = false;
    try {
      // Пустой пароль в форме означает «не менять»: берём текущий (сохранённый
      // или из окружения), чтобы правка хоста не обнулила учётные данные.
      const current = await loadSmtpSettings(prisma);
      const settings: SmtpSettings = {
        host: parsed.data.host,
        port: parsed.data.port,
        user: parsed.data.user,
        from: parsed.data.from,
        password: parsed.data.password.trim() ? parsed.data.password : current.password
      };
      await saveSmtpSettings(prisma, settings);
      savedPasswordSet = settings.password.length > 0;
    } catch (error) {
      app.log.error({ err: error }, "Could not save SMTP settings");
      return reply.code(500).send({ error: "Не удалось сохранить параметры SMTP." });
    }
    app.log.warn(
      { actor: request.sessionUser?.login, host: parsed.data.host },
      "SMTP settings updated via portal config"
    );
    return {
      smtp: {
        host: parsed.data.host,
        port: parsed.data.port,
        user: parsed.data.user,
        from: parsed.data.from,
        passwordSet: savedPasswordSet
      }
    };
  });

  app.post("/api/coordination/preview", { preHandler: rateLimitPerUser(previewRateLimit) }, async (request, reply) => {
    if (!request.isMultipart()) {
      return reply.code(406).send({ error: "Ожидается загрузка файла в формате multipart/form-data." });
    }

    let buffer: Buffer | null = null;
    let filename = "";
    const fields: Record<string, string> = {};

    try {
      // Глобальные лимиты рассчитаны на XLSX без полей — переопределяем их
      // на время этого запроса (см. previewMultipartLimits).
      for await (const part of request.parts({ limits: previewMultipartLimits })) {
        if (part.type === "file") {
          const data = await part.toBuffer();
          if (part.file.truncated) {
            return reply.code(413).send({ error: "DOCX-файл больше допустимого лимита." });
          }
          // Второй файл в одной форме не нужен: пропускаем, лимит files: 1
          // и так не даст записать его как основной.
          if (buffer === null) {
            buffer = data;
            filename = part.filename;
          }
        } else {
          fields[part.fieldname] = String(part.value ?? "");
        }
      }
    } catch (error) {
      app.log.warn({ err: error }, "Could not read coordination multipart upload");
      return reply.code(400).send({ error: "Не удалось прочитать загруженную форму. Проверьте файл и повторите." });
    }

    if (!buffer) return reply.code(400).send({ error: "Выберите DOCX-файл плана работ." });
    const normalized = filename.split(/[\\/]/).pop() ?? "";
    if (!normalized.toLocaleLowerCase("en").endsWith(".docx")) {
      return reply.code(400).send({ error: "Поддерживаются файлы .docx." });
    }

    const fieldsParsed = previewFieldsSchema.safeParse({
      region: fields.region,
      contractor: fields.contractor,
      workDate: fields.workDate
    });
    if (!fieldsParsed.success) {
      return reply.code(400).send({ error: fieldsParsed.error.issues[0]?.message ?? "Проверьте данные формы." });
    }

    try {
      const letter = await buildLetterFromDocx(buffer, fieldsParsed.data);
      return { ...letter, fileName: normalized.slice(0, 255) };
    } catch (error) {
      app.log.error({ err: error }, "Could not parse coordination DOCX");
      return reply.code(400).send({ error: "Не удалось разобрать DOCX-файл. Убедитесь, что это документ Word и он не повреждён." });
    }
  });

  app.post("/api/coordination/send", { preHandler: rateLimitPerUser(sendLetterRateLimit) }, async (request, reply) => {
    const parsed = sendLetterSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "Проверьте тему и текст письма." });
    }

    const [recipients, smtpSettings] = await Promise.all([
      loadMailRecipients(prisma),
      loadSmtpSettings(prisma)
    ]);
    const actor = request.sessionUser;
    const logBase = {
      actorId: actor?.id ?? null,
      actorLogin: actor?.login ?? null,
      actorRole: actor?.role ?? null,
      ip: request.ip,
      method: request.method,
      path: request.url,
      request: { subject: parsed.data.subject, recipients }
    };

    try {
      const result = await sendLetter(parsed.data, recipients, smtpSettings);
      void recordLog(prisma, {
        ...logBase,
        action: "POST /api/coordination/send",
        message: `Письмо «${parsed.data.subject}» отправлено получателям: ${recipients.join(", ")}`,
        status: 200
      });
      return { sent: true, recipients, messageId: result.messageId };
    } catch (error) {
      app.log.error({ err: error }, "Could not send coordination letter");
      const message = describeSendError(error);
      void recordLog(prisma, {
        ...logBase,
        level: "ERROR",
        action: "POST /api/coordination/send",
        message: `Не удалось отправить письмо «${parsed.data.subject}»: ${message}`,
        status: 502,
        error: error instanceof Error ? error.message : String(error)
      });
      return reply.code(502).send({ error: message });
    }
  });
}
