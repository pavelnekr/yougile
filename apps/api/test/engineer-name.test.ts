import assert from "node:assert/strict";
import test from "node:test";
import { normalizeEngineerName } from "../src/lib/engineer-name.js";

test("нормализация игнорирует порядок слов, регистр, пробелы и ё", () => {
  assert.equal(normalizeEngineerName("  Иван   Шерстнев "), normalizeEngineerName("шерстнёв ИВАН"));
});

test("нормализация сохраняет различия в составе имени", () => {
  assert.notEqual(normalizeEngineerName("Иван Иванов"), normalizeEngineerName("Иван Петров"));
});
