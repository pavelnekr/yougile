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
  assert.equal(sendLetterSchema.safeParse({ subject: "Тема", body: "Текст" }).success, true);
  assert.equal(sendLetterSchema.safeParse({ subject: "", body: "Текст" }).success, false);
  assert.equal(sendLetterSchema.safeParse({ subject: "Тема", body: "x".repeat(100_001) }).success, false);
});
