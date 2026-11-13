import type { FastifyInstance } from "fastify";
import { PortalRole, type PrismaClient } from "@prisma/client";
import { config } from "../../config.js";
import { YougileTokenEncryptionKeyError } from "../../integrations/yougile/token-crypto.js";
import { operatorContactsViewRateLimit, previewRateLimit, rateLimitPerUser, sendLetterRateLimit } from "../auth/rate-limit.js";
import { requireRole, requireWorkspaceAccess } from "../auth/service.js";
import { recordLog } from "../logs/service.js";
import { letterTemplateSchema, mailRecipientsSchema, previewFieldsSchema, sendLetterSchema, smtpSettingsSchema } from "./schema.js";
import { clearOperatorContacts, extractSiteNumber, getOperatorContactsMetadata, loadOperatorContacts, OperatorContactsLookupError, parseOperatorContactsWorkbook, resolveOperatorRecipients, saveOperatorContacts } from "./operator-contacts.js";
import {
  buildLetterFromDocx,
  describeSendError,
  isSmtpConfigured,
  loadLetterTemplate,
  loadSmtpSettings,
  saveMailRecipients,
  saveLetterTemplate,
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
 * Получатели определяются по номеру площадки из зашифрованного справочника
 * операторов; настройки SMTP остаются в AppSetting.
 */
export async function registerCoordinationRoutes(app: FastifyInstance, prisma: PrismaClient) {
  const adminOnly = requireRole(PortalRole.ADMIN);
  const readAccess = requireWorkspaceAccess("COORDINATION");
  const writeAccess = requireWorkspaceAccess("COORDINATION", true);

  app.get("/api/coordination/config", { preHandler: readAccess }, async (_request, reply) => {
    try {
      const [settings, template] = await Promise.all([
        loadSmtpSettings(prisma, (message) => app.log.warn({ module: "coordination" }, message)),
        loadLetterTemplate(prisma)
      ]);
      return {
        template,
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

  app.put("/api/coordination/template", { preHandler: adminOnly }, async (request, reply) => {
    const parsed = letterTemplateSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "Проверьте шаблон письма." });
    try {
      await saveLetterTemplate(prisma, parsed.data);
      app.log.warn({ actor: request.sessionUser?.login }, "Coordination letter template updated");
      return { template: parsed.data };
    } catch (error) {
      app.log.error({ err: error }, "Could not save coordination letter template");
      return reply.code(500).send({ error: "Не удалось сохранить шаблон письма." });
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

  app.get("/api/coordination/operator-contacts/status", { preHandler: readAccess }, async (_request, reply) => {
    try {
      return { ...await getOperatorContactsMetadata(prisma), canManage: true };
    } catch (error) {
      app.log.error({ err: error }, "Could not read operator contacts metadata");
      return reply.code(500).send({ error: "Не удалось прочитать состояние справочника." });
    }
  });

  app.delete("/api/coordination/operator-contacts", { preHandler: readAccess }, async (request, reply) => {
    try {
      const deleted = await clearOperatorContacts(prisma);
      app.log.warn({ actor: request.sessionUser?.login, deleted }, "Operator contacts directory cleared");
      return { deleted, message: deleted ? "Справочник удалён." : "Справочник уже был пуст." };
    } catch (error) {
      app.log.error({ err: error, actor: request.sessionUser?.login }, "Could not clear operator contacts directory");
      return reply.code(500).send({ error: "Не удалось очистить справочник операторов." });
    }
  });

  app.post("/api/coordination/operator-contacts/upload", { preHandler: readAccess }, async (request, reply) => {
    if (!request.isMultipart()) return reply.code(406).send({ error: "Загрузите XLSX-файл." });
    try {
      let buffer: Buffer | null = null;
      let originalFilename = "";
      let workbookPassword = "";
      for await (const part of request.parts({ limits: { files: 1, fields: 1, parts: 2, fileSize: config.UPLOAD_MAX_BYTES, fieldSize: 255 } })) {
        if (part.type === "file") {
          buffer = await part.toBuffer();
          if (part.file.truncated) return reply.code(413).send({ error: "Файл превышает допустимый размер." });
          originalFilename = part.filename;
        } else if (part.fieldname === "password") {
          workbookPassword = String(part.value ?? "");
        }
      }
      if (!buffer) return reply.code(400).send({ error: "Выберите XLSX-файл справочника." });
      if (!workbookPassword) return reply.code(400).send({ error: "Введите пароль от XLSX-файла." });
      if (workbookPassword.length > 255) return reply.code(400).send({ error: "Пароль файла не должен превышать 255 символов." });
      const filename = originalFilename.split(/[\\/]/).pop() ?? "";
      if (!filename.toLocaleLowerCase("en").endsWith(".xlsx")) return reply.code(400).send({ error: "Поддерживаются файлы .xlsx." });
      const rows = await parseOperatorContactsWorkbook(buffer, workbookPassword);
      const actor = request.sessionUser;
      const result = await saveOperatorContacts(prisma, rows, actor?.login ?? null);
      app.log.warn({ actor: actor?.login, rowCount: result.rowCount }, "Operator contacts directory replaced");
      return { ...result, message: "Справочник загружен и сохранён в зашифрованном виде." };
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "FST_REQ_FILE_TOO_LARGE") {
        return reply.code(413).send({ error: "Файл превышает допустимый размер." });
      }
      if (error instanceof Error && (error.message.startsWith("Не удалось расшифровать файл") || error.message.startsWith("Не удалось прочитать расшифрованный XLSX"))) {
        app.log.warn({ actor: request.sessionUser?.login, reason: error.message }, "Operator contacts XLSX could not be parsed");
        return reply.code(400).send({ error: error.message });
      }
      if (error instanceof Error && /колонки|строк с данными|номер площадки|больше \d+ строк|В книге нет листов|защищён паролем/.test(error.message)) {
        app.log.warn({ actor: request.sessionUser?.login, reason: error.message }, "Operator contacts XLSX validation failed");
        return reply.code(400).send({ error: error.message });
      }
      if (error instanceof YougileTokenEncryptionKeyError) {
        app.log.error({ actor: request.sessionUser?.login }, "Operator contacts encryption key is not configured");
        return reply.code(503).send({ error: "На сервере не настроен ключ шифрования справочника." });
      }
      app.log.error({ err: error }, "Could not save operator contacts directory");
      return reply.code(500).send({ error: "Не удалось сохранить справочник операторов." });
    }
  });

  app.post("/api/coordination/operator-contacts/view", { preHandler: [readAccess, rateLimitPerUser(operatorContactsViewRateLimit)] }, async (request, reply) => {
    try {
      const snapshot = await loadOperatorContacts(prisma);
      if (!snapshot) return reply.code(404).send({ error: "Справочник ещё не загружен." });
      app.log.warn({ actor: request.sessionUser?.login, rowCount: snapshot.rows.length }, "Operator contacts directory viewed");
      return snapshot;
    } catch (error) {
      if (error instanceof YougileTokenEncryptionKeyError) {
        app.log.error({ actor: request.sessionUser?.login }, "Operator contacts encryption key is not configured");
        return reply.code(503).send({ error: "На сервере не настроен ключ шифрования справочника." });
      }
      app.log.error({ err: error }, "Could not decrypt operator contacts directory");
      return reply.code(500).send({ error: "Не удалось расшифровать справочник." });
    }
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
      if (error instanceof YougileTokenEncryptionKeyError) {
        app.log.error({ actor: request.sessionUser?.login }, "SMTP password encryption key is not configured");
        return reply.code(503).send({
          error: "На сервере не задан ключ шифрования (YOUGILE_TOKEN_ENCRYPTION_KEY) — пароль SMTP нельзя сохранить зашифрованным."
        });
      }
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

  app.post("/api/coordination/preview", { preHandler: [readAccess, rateLimitPerUser(previewRateLimit)] }, async (request, reply) => {
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
      const template = await loadLetterTemplate(prisma);
      const letter = await buildLetterFromDocx(buffer, fieldsParsed.data, template);
      const siteNumber = extractSiteNumber(letter.extracted.site);
      if (!siteNumber) {
        app.log.warn({ actor: request.sessionUser?.login, reason: "SITE_NUMBER_MISSING" }, "Could not determine coordination email recipients");
        return reply.code(422).send({ error: "В DOCX не найден корректный номер площадки. Проверьте поле «ID» в заявке." });
      }
      try {
        const directory = await resolveOperatorRecipients(prisma, siteNumber);
        return { ...letter, fileName: normalized.slice(0, 255), siteNumber, recipients: directory.recipients, directoryImportedAt: directory.directoryImportedAt };
      } catch (error) {
        if (error instanceof OperatorContactsLookupError) {
          app.log.warn({ actor: request.sessionUser?.login, siteNumber, lookupCode: error.code }, "Could not determine coordination email recipients");
          return reply.code(error.statusCode).send({ error: error.message });
        }
        app.log.error({ err: error, siteNumber }, "Could not read operator contacts for preview");
        return reply.code(500).send({ error: "Не удалось прочитать справочник email операторов. Предпросмотр недоступен." });
      }
    } catch (error) {
      if (error instanceof OperatorContactsLookupError) {
        app.log.warn({ actor: request.sessionUser?.login, lookupCode: error.code }, "Could not determine coordination email recipients");
        return reply.code(error.statusCode).send({ error: error.message });
      }
      app.log.error({ err: error }, "Could not parse coordination DOCX");
      return reply.code(400).send({ error: "Не удалось разобрать DOCX-файл. Убедитесь, что это документ Word и он не повреждён." });
    }
  });

  app.post("/api/coordination/send", { preHandler: [writeAccess, rateLimitPerUser(sendLetterRateLimit)] }, async (request, reply) => {
    const parsed = sendLetterSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "Проверьте тему и текст письма." });
    }

    let directory: Awaited<ReturnType<typeof resolveOperatorRecipients>>;
    try {
      directory = await resolveOperatorRecipients(prisma, parsed.data.siteNumber);
    } catch (error) {
      if (error instanceof OperatorContactsLookupError) {
        app.log.warn({ actor: request.sessionUser?.login, siteNumber: parsed.data.siteNumber, lookupCode: error.code }, "Could not determine coordination email recipients before sending");
        return reply.code(error.statusCode).send({ error: error.message });
      }
      app.log.error({ err: error, siteNumber: parsed.data.siteNumber }, "Could not read operator contacts before sending");
      return reply.code(500).send({ error: "Не удалось прочитать справочник email операторов. Письмо не отправлено." });
    }
    if (directory.directoryImportedAt !== parsed.data.directoryImportedAt) {
      return reply.code(409).send({ error: "Справочник адресатов обновился после предпросмотра. Пересоберите письмо и проверьте адресатов." });
    }
    const recipients = parsed.data.recipients;
    const cc = parsed.data.cc;
    const smtpSettings = await loadSmtpSettings(prisma, (message) => app.log.warn({ module: "coordination" }, message));
    const actor = request.sessionUser;
    const logBase = {
      actorId: actor?.id ?? null,
      actorLogin: actor?.login ?? null,
      actorRole: actor?.role ?? null,
      ip: request.ip,
      method: request.method,
      path: request.url,
      request: { subject: parsed.data.subject, siteNumber: parsed.data.siteNumber, recipientCount: recipients.length, ccCount: cc.length }
    };

    try {
      const result = await sendLetter(parsed.data, recipients, cc, smtpSettings);
      void recordLog(prisma, {
        ...logBase,
        action: "POST /api/coordination/send",
        message: `Письмо «${parsed.data.subject}» отправлено адресатам площадки ${parsed.data.siteNumber} (${recipients.length}, копия: ${cc.length}).`,
        status: 200
      });
      return { sent: true, recipients, cc, messageId: result.messageId };
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
