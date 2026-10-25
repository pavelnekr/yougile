import assert from "node:assert/strict";
import test from "node:test";
import { buildLetter, parseLetterSource } from "../src/modules/coordination/letter.js";

test("извлекает номер АВР, площадку, оборудование и шаги из HTML", () => {
  const html = `
    <p>Исх-123/456</p><p>ID: 00123 В случае необходимости</p>
    <table><tr><th>№</th><th>Наименование</th></tr><tr><td>1</td><td>Маршрутизатор &amp; модуль</td></tr></table>
    <table><tr><td>Этап работ</td><td>Регламентное время</td></tr><tr><td>Замена оборудования</td><td>30 мин.</td></tr></table>`;

  assert.deepEqual(parseLetterSource(html), {
    avrNumber: "456",
    site: "00123",
    equipment: [{ number: "1", name: "Маршрутизатор & модуль" }],
    steps: [{ step: "Замена оборудования", time: "30 мин." }]
  });
});

test("собирает тему и безопасно экранирует данные письма", () => {
  const result = buildLetter({
    avrNumber: "456",
    site: "00123",
    equipment: [{ number: "1", name: "Устройство <новое>" }],
    steps: [{ step: "Проверка & запуск", time: "30 мин." }]
  }, { region: "Москва", contractor: "ООО «Юстас»", workDate: "2026-10-25" });

  assert.equal(result.subject, "Согласование АВР №456 на УС ID00123, Москва");
  assert.match(result.body, /25\.10\.2026/);
  assert.match(result.body, /Устройство &lt;новое&gt;/);
  assert.match(result.body, /Проверка &amp; запуск/);
  assert.deepEqual(result.warnings, []);
});
