import type { PreviewFields } from "./schema.js";

/**
 * Разбор DOCX (через HTML из mammoth) и сборка письма.
 *
 * Перенос двух Code-узлов n8n-воркфлоу «[DEV] Nekrasov_Отправка_Писем_ПМО»:
 * «node-парсинг_таблиц» и «node-формирование_письма». Семантика совпадает:
 * номер АВР, площадка, список оборудования и таблица регламента ищутся теми же
 * регулярными выражениями. Отличия от n8n только две: сущности HTML
 * декодируются при разборе и экранируются при сборке (в n8n имя с «&» из
 * документа превращалось в показомое «&amp;»), и пустые поля дают предупреждение
 * оператору вместо молчаливого пропуска.
 */

export type ParsedLetterSource = {
  avrNumber: string | null;
  site: string | null;
  equipment: { number: string; name: string }[];
  steps: { step: string; time: string }[];
};

export type BuiltLetter = {
  subject: string;
  body: string;
  extracted: {
    avrNumber: string | null;
    site: string | null;
    equipmentCount: number;
    stepsCount: number;
  };
  warnings: string[];
};

const htmlEntityMap: Record<string, string> = {
  "&nbsp;": " ",
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&#x27;": "'",
  "&laquo;": "«",
  "&raquo;": "»",
  "&mdash;": "—",
  "&ndash;": "–"
};

/** Раскодирует основные HTML-сущности после удаления тегов. */
function decodeEntities(text: string): string {
  return text
    .replace(/&(?:nbsp|amp|lt|gt|quot|laquo|raquo|mdash|ndash);|&#(?:39|x27);/gi, (entity) => {
      const lower = entity.toLowerCase();
      return htmlEntityMap[lower] ?? htmlEntityMap[entity] ?? entity;
    })
    // Числовые сущности (`&#8470;` → «№»): Word и mammoth могут отдавать
    // символы так, а без декодирования заголовок «№» не совпадёт с «№».
    .replace(/&#(\d{1,7});/g, (entity, code: string) => {
      try {
        return String.fromCodePoint(Number(code));
      } catch {
        return entity;
      }
    })
    .replace(/&#x([0-9a-f]{1,6});/gi, (entity, code: string) => {
      try {
        return String.fromCodePoint(parseInt(code, 16));
      } catch {
        return entity;
      }
    });
}

/** Удаляет теги, раскодирует сущности и схлопывает пробелы — текст для разбора. */
function stripTags(html: string): string {
  return decodeEntities(
    html
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/gi, " ")
  ).replace(/\s+/g, " ").trim();
}

/** Экранирует текст перед вставкой в HTML письма. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

type Table = string[][];

function parseTables(html: string): Table[] {
  const tables: Table[] = [];
  for (const tableMatch of html.matchAll(/<table[^>]*>([\s\S]*?)<\/table>/g)) {
    const rows: string[][] = [];
    for (const rowMatch of tableMatch[1].matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)) {
      const cells: string[] = [];
      for (const cellMatch of rowMatch[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g)) {
        cells.push(stripTags(cellMatch[1]));
      }
      rows.push(cells);
    }
    tables.push(rows);
  }
  return tables;
}

/** Разбирает HTML документа: номер АВР, площадку, оборудование и регламент. */
export function parseLetterSource(html: string): ParsedLetterSource {
  const fullText = stripTags(html);

  const avrMatch = fullText.match(/Исх-[^/\\]+[/\\](\d+)/);
  const avrNumber = avrMatch ? avrMatch[1] : null;

  const siteMatch = fullText.match(/\bID[:\s]+(.+?)(?=\s+В случае|\s+Общество|\s+Указанные|$)/);
  const site = siteMatch ? siteMatch[1].trim().replace(/\.$/, "") : null;

  const tables = parseTables(html);

  // Таблица оборудования: заголовок содержит «№» и «Наименование».
  const equipment: { number: string; name: string }[] = [];
  const seen = new Set<string>();
  for (const rows of tables) {
    if (rows.length < 2) continue;
    const header = rows[0];
    const numIdx = header.findIndex((cell) => cell.replace(/\s/g, "") === "№");
    const nameIdx = header.findIndex((cell) => cell.toLowerCase().includes("наименование"));
    if (numIdx === -1 || nameIdx === -1) continue;
    for (const row of rows.slice(1)) {
      const number = (row[numIdx] ?? "").trim();
      const name = (row[nameIdx] ?? "").trim();
      if (!/^\d+$/.test(number) || !name) continue;
      if (seen.has(number)) continue;
      seen.add(number);
      equipment.push({ number, name });
    }
  }

  // Таблица регламента: во втором столбце есть «мин.», а первый столбец —
  // осмысленный текст длиннее пяти символов.
  const steps: { step: string; time: string }[] = [];
  for (const rows of tables) {
    const isScheduleTable = rows.some((row) =>
      row.length >= 2 &&
      /мин\.?/i.test(row[1] ?? "") &&
      (row[0] ?? "").length > 5
    );
    if (!isScheduleTable) continue;
    for (const row of rows) {
      const step = (row[0] ?? "").trim();
      const time = (row[1] ?? "").trim();
      if (!step) continue;
      if (/регламентное время/i.test(step)) continue;
      // Строка-заголовок самой таблицы («Этап работ | Регламентное время»):
      // в логике n8n она ошибочно попадала в тело письма отдельной строкой,
      // хотя заголовок уже есть в шапке алгоритма. Пропускаем.
      if (/регламентное время/i.test(time)) continue;
      if (/мин\.?/i.test(step) && !time) continue;
      steps.push({ step, time });
    }
  }

  return { avrNumber, site, equipment, steps };
}

/** 2026-10-15 → 15.10.2026: в письме дата читается в русском формате. */
function formatWorkDate(value: string): string {
  const [year, month, day] = value.split("-");
  if (!year || !month || !day) return value;
  return `${day}.${month}.${year}`;
}

/**
 * Собирает тему и HTML-тело письма по тому же шаблону, что и узел
 * «node-формирование_письма» из воркфлоу.
 */
export function buildLetter(source: ParsedLetterSource, fields: PreviewFields): BuiltLetter {
  const avrNumber = source.avrNumber ?? "";
  const site = source.site ?? "";
  const region = fields.region;
  const contractor = fields.contractor;
  const workDate = formatWorkDate(fields.workDate);

  const warnings: string[] = [];
  if (!source.avrNumber) warnings.push("В документе не найден номер АВР (формат «Исх-…/NNN») — он не попадёт в тему письма.");
  if (!source.site) warnings.push("В документе не найден идентификатор площадки («ID: …») — в письме будет пусто.");
  if (source.equipment.length === 0) warnings.push("Не найдена таблица оборудования — список замен будет пустым.");
  if (source.steps.length === 0) warnings.push("Не найдена таблица регламента — алгоритм работ будет пустым.");

  const equipmentList = source.equipment
    .map((equipment, index) => `${index + 1}. ${escapeHtml(equipment.name)}`)
    .join("<br>");

  const rows = source.steps.map((step, index) => `
    <tr>
      <td align="center" style="border: 1px solid #ccc;">${index + 1}</td>
      <td style="border: 1px solid #ccc;">${escapeHtml(step.step)}</td>
      <td align="center" style="border: 1px solid #ccc;">${escapeHtml(step.time)}</td>
    </tr>
  `).join("");

  const algoTable = `
<table border="1" cellpadding="6" cellspacing="0" style="border-collapse: collapse; border: 1px solid #ccc; width: 100%;">
  <thead>
    <tr style="background-color: #f0f0f0;">
      <th align="center" style="border: 1px solid #ccc; width: 40px;">№</th>
      <th align="left" style="border: 1px solid #ccc;">Этап работ</th>
      <th align="center" style="border: 1px solid #ccc; width: 160px;">Регламентное время</th>
    </tr>
  </thead>
  <tbody>${rows}
  </tbody>
</table>`;

  const body = [
    "Уважаемые коллеги, добрый день!",
    "<br><br>",
    `В рамках ТП ТСПУ необходимо провести АВР на узле связи: ID ${escapeHtml(site)}`,
    "<br><br>",
    "Работы по замене: ",
    "<br>",
    equipmentList,
    "<br><br>",
    `Работы будет выполнять инженер ТП, субподрядчик ГРЧЦ – ${escapeHtml(contractor)}`,
    "<br>",
    `Данные инженеров предоставит представитель ${escapeHtml(contractor)}`,
    "<br><br>",
    "Прошу согласовать:",
    "<br>",
    `- допуск инженера ${escapeHtml(contractor)} для выполнения АВР;`,
    "<br>",
    `- время и дату проведения работ (по возможности в ночь с ${escapeHtml(workDate)} на ..).`,
    "<br><br>",
    "Ответным письмом прошу указать контактное лицо на УС (ФИО и контактный номер телефона) инженера,",
    "<br>",
    "который сможет осуществлять технадзор и поддерживать связь с работниками технической поддержки во время проведения работ,",
    "<br>",
    "а так же на какое число и время согласованы АВР.",
    "<br><br>",
    "Алгоритм работ:",
    "<br><br>",
    algoTable
  ].join("");

  const subject = `Согласование АВР №${avrNumber} на УС ID${site}, ${region}`;

  return {
    subject,
    body,
    extracted: {
      avrNumber: source.avrNumber,
      site: source.site,
      equipmentCount: source.equipment.length,
      stepsCount: source.steps.length
    },
    warnings
  };
}
