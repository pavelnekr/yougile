import assert from "node:assert/strict";
import test from "node:test";
import { mailRecipientsSchema, previewFieldsSchema, sendLetterSchema } from "../src/modules/coordination/schema.js";

test("валидирует поля предпросмотра письма и отклоняет неизвестного подрядчика", () => {
  assert.equal(previewFieldsSchema.safeParse({
    region: "Москва", contractor: "ООО «Юстас»", workDate: "2026-10-25"
  }).success, true);
  assert.equal(previewFieldsSchema.safeParse({
    region: "Москва", contractor: "Другой подрядчик", workDate: "2026-10-25"
  }).success, false);
});

test("отклоняет повторяющиеся адреса получателей без учёта регистра", () => {
  assert.equal(mailRecipientsSchema.safeParse({ recipients: ["ops@example.com", "OPS@example.com"] }).success, false);
  assert.equal(mailRecipientsSchema.safeParse({ recipients: ["ops@example.com"] }).success, true);
});

test("ограничивает пустые и чрезмерно длинные письма", () => {
  const validPayload = {
    siteNumber: "00123",
    directoryImportedAt: "2026-10-25T10:00:00.000Z",
    subject: "Тема",
    body: "Текст"
  };
  assert.equal(sendLetterSchema.safeParse(validPayload).success, true);
  assert.equal(sendLetterSchema.safeParse({ ...validPayload, siteNumber: "123A" }).success, false);
  assert.equal(sendLetterSchema.safeParse({ ...validPayload, directoryImportedAt: "invalid" }).success, false);
  assert.equal(sendLetterSchema.safeParse({ ...validPayload, subject: "" }).success, false);
  assert.equal(sendLetterSchema.safeParse({ ...validPayload, body: "x".repeat(100_001) }).success, false);
});
