import ExcelJS from "exceljs";

export type ParsedPlanRow = {
  rowNumber: number;
  siteId: string | null;
  address: string | null;
  engineerName: string | null;
  rawData: Record<string, string>;
};

export type ParsedPlan = {
  sheetName: string;
  rows: ParsedPlanRow[];
};

const maximumRows = 5_000;

function normalizeHeader(header: string) {
  return header.normalize("NFKC").trim().toLocaleLowerCase("ru").replace(/[^a-zа-яё0-9]/gi, "");
}

function getCellText(cell: ExcelJS.Cell): string {
  const value = cell.value;
  if (value === null || value === undefined) return "";
  if (value instanceof Date && Number.isFinite(value.getTime())) {
    const day = String(value.getUTCDate()).padStart(2, "0");
    const month = String(value.getUTCMonth() + 1).padStart(2, "0");
    return `${day}.${month}.${value.getUTCFullYear()}`;
  }
  return cell.text.trim();
}

function findColumn(headers: string[], aliases: string[]) {
  const normalizedAliases = new Set(aliases.map(normalizeHeader));
  return headers.findIndex((header) => normalizedAliases.has(normalizeHeader(header)));
}

export async function parsePlanWorkbook(buffer: Buffer): Promise<ParsedPlan> {
  const workbook = new ExcelJS.Workbook();
  const workbookBuffer = new ArrayBuffer(buffer.byteLength);
  new Uint8Array(workbookBuffer).set(buffer);
  await workbook.xlsx.load(workbookBuffer);

  const worksheet = workbook.worksheets[0];
  if (!worksheet) throw new Error("В XLSX-файле нет листов.");
  if (worksheet.rowCount > maximumRows + 1) {
    throw new Error(`В плане слишком много строк. Максимум: ${maximumRows}.`);
  }

  const headerRow = worksheet.getRow(1);
  const headers: string[] = [];
  for (let columnNumber = 1; columnNumber <= worksheet.actualColumnCount; columnNumber++) {
    headers.push(getCellText(headerRow.getCell(columnNumber)));
  }
  const siteColumn = findColumn(headers, ["id_site", "site_id", "номер площадки", "код площадки"]);
  const engineerColumn = findColumn(headers, ["user", "engineer", "инженер", "ответственный"]);
  const addressColumn = findColumn(headers, ["address", "адрес", "площадка"]);

  if (siteColumn === -1 || engineerColumn === -1) {
    throw new Error('Не найдены обязательные столбцы "id_site" и "user". Проверьте строку заголовков XLSX.');
  }

  const rows: ParsedPlanRow[] = [];
  for (let rowNumber = 2; rowNumber <= worksheet.rowCount; rowNumber++) {
    const row = worksheet.getRow(rowNumber);
    const rawData: Record<string, string> = {};
    headers.forEach((header, index) => {
      if (header) rawData[header] = getCellText(row.getCell(index + 1));
    });
    if (!Object.values(rawData).some(Boolean)) continue;

    const siteValue = getCellText(row.getCell(siteColumn + 1));
    const engineerValue = getCellText(row.getCell(engineerColumn + 1));
    const addressValue = addressColumn === -1 ? "" : getCellText(row.getCell(addressColumn + 1));

    rows.push({
      rowNumber,
      siteId: siteValue.trim() || null,
      address: addressValue || null,
      engineerName: engineerValue || null,
      rawData
    });
  }

  if (rows.length === 0) throw new Error("В XLSX-файле нет строк с планом работ.");
  return { sheetName: worksheet.name, rows };
}
