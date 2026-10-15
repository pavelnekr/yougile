import ExcelJS from "exceljs";
import type { DapsDataset, Prisma } from "@prisma/client";

export type DapsUploadFile = { fileName: string; buffer: Buffer };
export type ParsedDapsFile = {
  fileName: string;
  dataset: DapsDataset;
  rows: { externalKey: string; reportDate: Date | null; data: Prisma.InputJsonObject }[];
};

const weeklyCategories = [
  "ЛК ВТС",
  "Изменение правил фильтрации",
  "Актуализация ЦСУО",
  "Перевод площадки в фильтрацию",
  "Перевод площадки в фильтрацию",
  "Конфигурация оборудования",
  "Установка/снятие политик",
  "Подготовка отчетов",
  "Проверка фильтрации",
  "Проверка политик",
  "Согласование работ"
];
const weeklyCategoryMap: Record<string, string> = {
  "Установка/снятие политик фильтрации": "Установка/снятие политик"
};

function plain(value: ExcelJS.CellValue): unknown {
  if (value instanceof Date) return value.toISOString();
  if (value && typeof value === "object") {
    if ("text" in value && typeof value.text === "string") return value.text;
    if ("result" in value) return plain(value.result as ExcelJS.CellValue);
    if ("richText" in value && Array.isArray(value.richText)) return value.richText.map((part) => part.text).join("");
  }
  return value ?? null;
}

function sheetRows(sheet: ExcelJS.Worksheet, hasHeader = true) {
  const first = sheet.getRow(1);
  const headerValues = first.values;
  const headers = (Array.isArray(headerValues) ? headerValues.slice(1) : []).map((value, index) => String(plain(value as ExcelJS.CellValue) ?? `__EMPTY_${index}`).trim());
  const start = hasHeader ? 2 : 1;
  const rows: Record<string, unknown>[] = [];
  for (let rowNumber = start; rowNumber <= sheet.rowCount; rowNumber += 1) {
    const row = sheet.getRow(rowNumber);
    const result: Record<string, unknown> = {};
    for (let column = 1; column <= Math.max(headers.length, row.cellCount); column += 1) {
      const header = headers[column - 1] || `__EMPTY_${column - 1}`;
      result[header] = plain(row.getCell(column).value);
    }
    if (Object.values(result).some((value) => value !== null && value !== "")) rows.push(result);
  }
  return rows;
}

function dateOnly(value: unknown): Date | null {
  if (value instanceof Date && Number.isFinite(value.getTime())) {
    return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()));
  }
  if (typeof value === "number" && value > 1) {
    const date = new Date((value - 25569) * 86400000);
    if (Number.isFinite(date.getTime())) return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  }
  if (typeof value !== "string") return null;
  const raw = value.trim();
  const iso = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
  const ru = raw.match(/^(\d{1,2})[./](\d{1,2})[./](\d{2,4})/);
  const short = raw.toLowerCase().match(/^(\d{1,2})\.([а-яё]{3})$/u);
  if (iso) return new Date(Date.UTC(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3])));
  if (ru) {
    const year = Number(ru[3].length === 2 ? `20${ru[3]}` : ru[3]);
    return new Date(Date.UTC(year, Number(ru[2]) - 1, Number(ru[1])));
  }
  if (short) {
    const months: Record<string, number> = { янв: 0, фев: 1, мар: 2, апр: 3, май: 4, июн: 5, июл: 6, авг: 7, сен: 8, окт: 9, ноя: 10, дек: 11 };
    const month = months[short[2]];
    if (month !== undefined) return new Date(Date.UTC(new Date().getUTCFullYear(), month, Number(short[1])));
  }
  return null;
}

function jsonObject(value: Record<string, unknown>): Prisma.InputJsonObject {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonObject;
}

function excelDuration(value: unknown) {
  const days = Number(value);
  if (!Number.isFinite(days)) return "00:00:00";
  const seconds = Math.max(0, Math.floor(days * 86400));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

function reportDateFromName(fileName: string): Date | null {
  const match = fileName.match(/(\d{2})\.(\d{2})\.(\d{4})\.xlsx$/i);
  if (!match) return null;
  return new Date(Date.UTC(Number(match[3]), Number(match[2]) - 1, Number(match[1])));
}

function datasetForFile(fileName: string): DapsDataset | null {
  const name = fileName.toLocaleLowerCase("ru-RU");
  if (name.includes("к3_по неделям")) return "POLITICS_WEEKLY";
  if (name.includes("отчет о смене ответственного")) return "RESPONSIBLE_CHANGES";
  if (name.includes("отчет о смене статусов")) return "STATUS_CHANGES";
  if (name.includes("exportsd")) return "AGGREGATE";
  if (/\d{2}\.\d{2}\.\d{4}\.xlsx$/i.test(fileName)) return "KPI_REPORT" as DapsDataset;
  return null;
}

function parseAggregate(rows: Record<string, unknown>[], fileName: string): ParsedDapsFile["rows"] {
  return rows.flatMap((row) => {
    const number = String(row.Номер ?? "").trim();
    if (!number) return [];
    const rawProblem = String(row["Тип проблемы"] ?? "");
    const cleaned = rawProblem.split(",")[0].trim();
    const problemMap: Record<string, string> = {
      "Сбой программной части (байпас)": "Сбой программной части",
      "Сбой программной части (фильтр)": "Сбой программной части",
      "Сбой программной части (сервер)": "Сбой программной части",
      "Сбой программной части (балансировщик)": "Сбой программной части",
      "Сбой программной части (пробник)": "Сбой программной части",
      "Сбой программной части (коммутатор)": "Сбой программной части",
      "Сбой программной части (маршрутизатор)": "Сбой программной части",
      "Сбой аппаратной части (байпас)": "Сбой аппаратной части",
      "Сбой аппаратной части (фильтр)": "Сбой аппаратной части",
      "Сбой аппаратной части (сервер)": "Сбой аппаратной части",
      "Сбой аппаратной части (балансировщик)": "Сбой аппаратной части",
      "Сбой аппаратной части (пробник)": "Сбой аппаратной части",
      "Сбой аппаратной части (коммутатор)": "Сбой аппаратной части",
      "Недоступность ресурсов (сайт/протокол)": "Недоступность ресурсов",
      "Проблемы с физическим подключением (на участке внутри ТСПУ)": "Проблемы с физическим подключением",
      "Проблемы с физическим подключением в ЗО ОС(на участке ТСПУ-ОС)": "Проблемы с физическим подключением в ЗО ОС",
      "Проблемы с физическим подключением в ЗО ТСПУ(на участке ТСПУ-ОС)": "Проблемы с физическим подключением в ЗО ОС"
    };
    const responsible = String(row.Ответственный ?? "").trim();
    const thirdLine = row["Номер кейса на 3-й линии"];
    const normalized = { ...row };
    for (const field of [
      "Запас времени реакции по Инциденту",
      "Время восстановления сервиса по Инциденту",
      "Время обработки заявки",
      "Время реакции по Инциденту"
    ]) {
      normalized[field] = excelDuration(row[field]);
    }
    return [{ externalKey: number, reportDate: dateOnly(row["Время получения обращения"]), data: jsonObject({
      ...normalized,
      "Тип проблемы очищенный": cleaned,
      "Тип проблемы укрупненный": problemMap[cleaned] ?? cleaned,
      "Привлечение третьей линии": thirdLine !== null && thirdLine !== undefined && thirdLine !== "" ? "Да" : "Нет",
      "Группа ответственных": responsible.includes("/") ? responsible.slice(responsible.indexOf("/") + 1).trim() : responsible,
      sourceFile: fileName
    }) }];
  });
}

function parseKpi(rows: Record<string, unknown>[], fileName: string): ParsedDapsFile["rows"] {
  const values: Record<string, unknown> = {};
  let reportDate: Date | null = null;
  for (const row of rows) {
    const indicator = String(row.Показатель ?? "").trim();
    const factColumn = Object.keys(row).find((key) => key.startsWith("Факт за"));
    const raw = factColumn ? row[factColumn] : undefined;
    if (indicator && raw !== undefined && raw !== null && indicator !== "К0") {
      const numeric = Number(String(raw).replace(",", "."));
      values[`KPI-${indicator.slice(1).padStart(2, "0")}`] = Number.isFinite(numeric) ? numeric * 100 : raw;
    }
    if (indicator === "К0") {
      for (const [source, target] of [["КПЭ ПНР", "KPI-03(PNR)"], ["КПЭ АВР", "KPI-03(AVR)"]] as const) {
        if (row[source] !== undefined && row[source] !== null) {
          const numeric = Number(String(row[source]).replace(",", "."));
          values[target] = Number.isFinite(numeric) ? numeric * 100 : row[source];
        }
      }
    }
    if (factColumn && !reportDate) reportDate = dateOnly(factColumn.replace(/^Факт за\s*/u, ""));
  }
  reportDate ??= reportDateFromName(fileName);
  if (!reportDate) throw new Error(`В файле «${fileName}» не удалось определить дату KPI.`);
  return [{ externalKey: reportDate.toISOString().slice(0, 10), reportDate, data: jsonObject({ ...values, _date: reportDate.toISOString().slice(0, 10) }) }];
}

function parseStatusChanges(rows: Record<string, unknown>[]): ParsedDapsFile["rows"] {
  return rows.flatMap((row) => {
    const eventNumber = String(row["№ события "] ?? row["№ события"] ?? "").trim();
    const eventTime = String(row["Время события"] ?? "").trim();
    if (!eventNumber || !eventTime) return [];
    const date = new Date(eventTime.replace(" ", "T") + (eventTime.endsWith("Z") ? "" : "Z"));
    const data = jsonObject({
      event_number: eventNumber,
      event_time: Number.isFinite(date.getTime()) ? date.toISOString() : eventTime,
      event_author: row["Автор события"] ?? null,
      previous_status: row["Предыдущий статус"] ?? null,
      time_in_status: row["Время проведенное в статусе"] ?? null,
      new_status: row["Новый статус"] ?? null
    });
    return [{ externalKey: `${eventNumber}:${eventTime}`, reportDate: Number.isFinite(date.getTime()) ? date : null, data }];
  });
}

function getLastSunday(now = new Date()) {
  const lastSunday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const weekday = lastSunday.getUTCDay();
  if (weekday !== 0) lastSunday.setUTCDate(lastSunday.getUTCDate() - weekday);
  return lastSunday;
}

function isoWeek(date: Date) {
  const day = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNumber = day.getUTCDay() || 7;
  day.setUTCDate(day.getUTCDate() + 4 - dayNumber);
  const year = day.getUTCFullYear();
  const firstThursday = new Date(Date.UTC(year, 0, 4));
  const week = Math.ceil((((day.getTime() - firstThursday.getTime()) / 86400000) + 1) / 7);
  return { year, week };
}

async function parseWeekly(workbook: ExcelJS.Workbook, fileName: string) {
  const dailySheet = workbook.getWorksheet("ЛКВТС");
  const weeklySheet = workbook.getWorksheet("Последняя неделя");
  if (!dailySheet || !weeklySheet) throw new Error(`Файл «${fileName}» должен содержать листы «ЛКВТС» и «Последняя неделя».`);
  const dailyRows = sheetRows(dailySheet);
  const lastSeven = dailyRows.flatMap((row) => {
    const date = dateOnly(row.дата);
    if (!date) return [];
    return [{ externalKey: date.toISOString().slice(0, 10), reportDate: date, data: jsonObject({
      date: date.toISOString().slice(0, 10),
      received: row.поступило ?? null,
      processed: row.отработано ?? null
    }) }];
  }).slice(-7);

  const weekRow: Record<string, unknown> = Object.fromEntries(weeklyCategories.map((category) => [category, 0]));
  for (let rowNumber = 1; rowNumber <= weeklySheet.rowCount; rowNumber += 1) {
    const row = weeklySheet.getRow(rowNumber);
    for (let column = 1; column < row.cellCount; column += 1) {
      const category = String(plain(row.getCell(column).value) ?? "").trim();
      const normalized = weeklyCategoryMap[category] ?? category;
      if (normalized in weekRow) weekRow[normalized] = Number(plain(row.getCell(column + 1).value)) || 0;
    }
  }
  const { year, week } = isoWeek(getLastSunday());
  const weekLabel = `${year}-${String(week).padStart(2, "0")}`;
  const weeklyData = jsonObject({ ...weekRow, Неделя: weekLabel, id: Math.max(0, (year - 2026) * 53 + week) });
  const weeklyItem = { externalKey: weekLabel, reportDate: getLastSunday(), data: weeklyData };
  return { daily: lastSeven, weekly: [weeklyItem] };
}

export async function parseDapsUpload(file: DapsUploadFile): Promise<ParsedDapsFile[]> {
  const dataset = datasetForFile(file.fileName);
  if (!dataset) throw new Error(`Неизвестный тип отчёта в имени файла «${file.fileName}».`);
  const workbook = new ExcelJS.Workbook();
  const workbookBuffer = new ArrayBuffer(file.buffer.byteLength);
  new Uint8Array(workbookBuffer).set(file.buffer);
  await workbook.xlsx.load(workbookBuffer);

  if (dataset === "POLITICS_WEEKLY") {
    const parsed = await parseWeekly(workbook, file.fileName);
    return [
      { fileName: file.fileName, dataset: "POLITICS", rows: parsed.daily.map((row) => ({ ...row, data: row.data })) },
      { fileName: file.fileName, dataset: "POLITICS_WEEKLY", rows: parsed.weekly }
    ];
  }

  const sheet = workbook.worksheets[0];
  if (!sheet) throw new Error(`Файл «${file.fileName}» не содержит листов.`);
  const rows = sheetRows(sheet);
  let parsedRows: ParsedDapsFile["rows"];
  switch (dataset) {
    case "AGGREGATE": parsedRows = parseAggregate(rows, file.fileName); break;
    case "KPI_REPORT": parsedRows = parseKpi(rows, file.fileName); break;
    case "STATUS_CHANGES": parsedRows = parseStatusChanges(rows); break;
    case "RESPONSIBLE_CHANGES":
      parsedRows = rows.flatMap((row, index) => {
        const key = String(row.Номер ?? row["№"] ?? row["Номер заявки"] ?? index + 2).trim();
        return [{ externalKey: key, reportDate: dateOnly(row.дата ?? row["Дата"]), data: jsonObject(row) }];
      });
      break;
    default: throw new Error(`Обработка файла «${file.fileName}» пока не поддерживается.`);
  }
  if (!parsedRows.length) throw new Error(`В файле «${file.fileName}» не найдено строк для загрузки.`);
  return [{ fileName: file.fileName, dataset, rows: parsedRows }];
}

export function computeKpiZero(rows: { data: Prisma.JsonValue }[]) {
  const buckets = new Map<string, { count: number; sumDays: number; valid: boolean }>();
  for (const item of rows) {
    const data = item.data as Record<string, unknown>;
    const received = dateTime(data["Время получения обращения"]);
    if (!received) continue;
    const businessDate = new Date(received);
    if (received.getUTCHours() < 9) businessDate.setUTCDate(businessDate.getUTCDate() - 1);
    const key = businessDate.toISOString().slice(0, 10);
    const bucket = buckets.get(key) ?? { count: 0, sumDays: 0, valid: false };
    bucket.count += 1;
    const createdValue = data["Дата создания"];
    if (createdValue !== null && createdValue !== undefined && createdValue !== "") {
      const created = dateTime(createdValue);
      if (created) {
        bucket.sumDays += (created.getTime() - received.getTime()) / 86400000;
        bucket.valid = true;
      }
    }
    buckets.set(key, bucket);
  }
  return [...buckets.entries()].map(([date, bucket]) => {
    const average = bucket.count && bucket.valid ? bucket.sumDays / bucket.count : null;
    const totalSeconds = average !== null && average >= 0 ? Math.floor(average * 86400) : 0;
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    return {
      date: new Date(`${date}T00:00:00.000Z`),
      values: { "KPI-0": `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`, "KPI-0-FAIL": average !== null && average >= 0 ? "True" : "Fail" }
    };
  });
}

function dateTime(value: unknown): Date | null {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value;
  if (typeof value === "number" || (typeof value === "string" && /^\d+(?:\.\d+)?$/.test(value.trim()))) {
    const serial = Number(value);
    if (serial > 20000 && serial < 100000) {
      const date = new Date((serial - 25569) * 86400000);
      return Number.isFinite(date.getTime()) ? date : null;
    }
  }
  if (typeof value !== "string") return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}
