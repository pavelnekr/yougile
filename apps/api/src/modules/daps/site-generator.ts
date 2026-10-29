import ExcelJS from "exceljs";

export type GeneratorRackInput = {
  name: string;
  height: number;
  room: string;
  facilityId: string;
  locationId?: number;
};

export type GeneratorChassisInput = {
  name: string;
  rackName: string;
  position: number;
};

export type GeneratorSpecInput = {
  name: string;
  quantity: number;
  height: number;
};

export type ParsedSiteGeneratorFiles = {
  specificationDevices: GeneratorSpecInput[];
  ignoredItems: { name: string; quantity: number }[];
  racks: GeneratorRackInput[];
  chassis: GeneratorChassisInput[];
};

export type GeneratorDevicePlan = {
  name: string;
  deviceTypeId?: number;
  deviceTypeModel: string;
  deviceRoleId: number;
  height: number;
  rackName: string;
  position: number;
};

export type SiteGeneratorPlan = {
  racks: GeneratorRackInput[];
  devices: GeneratorDevicePlan[];
  deviceTypesToCreate: { model: string; height: number; manufacturerId?: number }[];
  manufacturerToCreate: boolean;
  ignoredItems: { name: string; quantity: number }[];
  chassisOnlyDevices: string[];
  roomsWithoutLocation: string[];
};

type NetboxDeviceType = { id: number; model: string; slug?: string; u_height?: number | null };
type NetboxManufacturer = { id: number; name: string; slug?: string };
type NetboxDeviceRole = { id: number; name: string; slug?: string };
type NetboxLocation = { id: number; name: string; site?: { id?: number } | null };
type NetboxRack = { id: number; name: string; site?: { id?: number } | null };

const normalize = (value: string) => value.normalize("NFKC").trim().replace(/ё/giu, "е").replace(/\s+/g, " ").toLocaleLowerCase("ru");
const normalizeHeader = (value: string) => normalize(value).replace(/[\s.,_\-()]+/g, "");

function worksheetByName(workbook: ExcelJS.Workbook, expected: string): ExcelJS.Worksheet | undefined {
  const key = normalizeHeader(expected);
  return workbook.worksheets.find((worksheet) => normalizeHeader(worksheet.name) === key);
}

function findHeaderColumns(worksheet: ExcelJS.Worksheet, required: string[], optional: string[] = []) {
  for (let rowNumber = 1; rowNumber <= Math.min(10, worksheet.rowCount); rowNumber += 1) {
    const columns = new Map<string, number>();
    worksheet.getRow(rowNumber).eachCell((cell, column) => columns.set(normalizeHeader(cell.text), column));
    if (required.every((header) => columns.has(normalizeHeader(header)))) {
      return { rowNumber, columns, optional: Object.fromEntries(optional.map((header) => [header, columns.get(normalizeHeader(header))])) };
    }
  }
  throw new Error(`На листе «${worksheet.name}» не найдены обязательные заголовки: ${required.join(", ")}.`);
}

function cellText(row: ExcelJS.Row, column: number | undefined): string {
  return column ? row.getCell(column).text.trim() : "";
}

function cellNumber(row: ExcelJS.Row, column: number | undefined, label: string, rowNumber: number): number {
  if (!column) throw new Error(`На листе не найден столбец «${label}».`);
  const text = cellText(row, column);
  const rawValue = row.getCell(column).value;
  const value = typeof rawValue === "number" ? rawValue : Number(text.replace(",", "."));
  if (!Number.isFinite(value)) throw new Error(`В строке ${rowNumber} поле «${label}» должно быть числом.`);
  return value;
}

async function loadWorkbook(buffer: Buffer, label: string): Promise<ExcelJS.Workbook> {
  const workbook = new ExcelJS.Workbook();
  try {
    const workbookData = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;
    await workbook.xlsx.load(workbookData);
  } catch {
    throw new Error(`Не удалось прочитать XLSX «${label}». Проверьте файл.`);
  }
  return workbook;
}

export async function parseSiteGeneratorFiles(specification: Buffer, facades: Buffer): Promise<ParsedSiteGeneratorFiles> {
  const [specWorkbook, facadesWorkbook] = await Promise.all([
    loadWorkbook(specification, "Спецификация"),
    loadWorkbook(facades, "Фасады")
  ]);
  const specSheet = worksheetByName(specWorkbook, "Лист1");
  if (!specSheet) throw new Error("В файле спецификации не найден лист «Лист1». Допускается название «Лист 1».");
  const racksSheet = facadesWorkbook.getWorksheet("Racks");
  const chassisSheet = facadesWorkbook.getWorksheet("Chassis");
  if (!racksSheet) throw new Error("В файле фасадов не найден лист «Racks».");
  if (!chassisSheet) throw new Error("В файле фасадов не найден лист «Chassis».");

  const specHeader = findHeaderColumns(specSheet, ["Наименование", "Кол-во", "Высота, RU"]);
  const specNameColumn = specHeader.columns.get(normalizeHeader("Наименование"))!;
  const specQuantityColumn = specHeader.columns.get(normalizeHeader("Кол-во"))!;
  const specHeightColumn = specHeader.columns.get(normalizeHeader("Высота, RU"))!;
  const specificationDevices: GeneratorSpecInput[] = [];
  const ignoredItems: { name: string; quantity: number }[] = [];
  for (let rowNumber = specHeader.rowNumber + 1; rowNumber <= specSheet.rowCount; rowNumber += 1) {
    const row = specSheet.getRow(rowNumber);
    const name = cellText(row, specNameColumn);
    if (!name || normalize(name) === "итого") continue;
    const quantityText = cellText(row, specQuantityColumn);
    // Some specification workbooks place explanatory notes in merged cells
    // below the table. ExcelJS exposes that note in both the name and quantity
    // columns, so it must not be interpreted as a device row.
    if (normalize(quantityText) === normalize(name)) continue;
    const quantity = cellNumber(row, specQuantityColumn, "Кол-во", rowNumber);
    if (!Number.isInteger(quantity) || quantity < 0 || quantity > 2_000) throw new Error(`В строке ${rowNumber} спецификации указано некорректное количество.`);
    if (quantity === 0) continue;
    // The workbook's optical cable organizers are consumable accessories, not
    // DCIM devices. Keep this rule narrow so an otherwise valid unpowered
    // device is not silently omitted from the generated site.
    if (normalize(name).includes("органайзер для укладки оптических линий")) {
      ignoredItems.push({ name, quantity });
      continue;
    }
    const height = cellNumber(row, specHeightColumn, "Высота, RU", rowNumber);
    if (!Number.isInteger(height) || height < 1 || height > 100) throw new Error(`В строке ${rowNumber} спецификации высота устройства должна быть от 1 до 100U.`);
    specificationDevices.push({ name, quantity, height });
  }
  if (specificationDevices.length === 0) throw new Error("В спецификации не найдено устройств для создания.");

  const rackHeader = findHeaderColumns(racksSheet, ["Название стойки", "Высота стойки (юниты)"], ["Помещение", "Сквозной номер стойки"]);
  const rackNameColumn = rackHeader.columns.get(normalizeHeader("Название стойки"))!;
  const rackHeightColumn = rackHeader.columns.get(normalizeHeader("Высота стойки (юниты)"))!;
  const rackRoomColumn = rackHeader.columns.get(normalizeHeader("Помещение"));
  const rackFacilityColumn = rackHeader.columns.get(normalizeHeader("Сквозной номер стойки"));
  const racks: GeneratorRackInput[] = [];
  for (let rowNumber = rackHeader.rowNumber + 1; rowNumber <= racksSheet.rowCount; rowNumber += 1) {
    const row = racksSheet.getRow(rowNumber);
    const name = cellText(row, rackNameColumn);
    if (!name) continue;
    const height = cellNumber(row, rackHeightColumn, "Высота стойки (юниты)", rowNumber);
    if (!Number.isInteger(height) || height < 1 || height > 100) throw new Error(`В строке ${rowNumber} листа Racks высота стойки должна быть от 1 до 100U.`);
    racks.push({ name, height, room: cellText(row, rackRoomColumn), facilityId: cellText(row, rackFacilityColumn) });
  }
  if (racks.length === 0) throw new Error("На листе Racks нет стоек для создания.");
  if (new Set(racks.map((rack) => normalize(rack.name))).size !== racks.length) throw new Error("На листе Racks повторяются названия стоек.");

  const chassisHeader = findHeaderColumns(chassisSheet, ["Устройство", "Стойка", "Нижний юнит"]);
  const chassisNameColumn = chassisHeader.columns.get(normalizeHeader("Устройство"))!;
  const chassisRackColumn = chassisHeader.columns.get(normalizeHeader("Стойка"))!;
  const chassisPositionColumn = chassisHeader.columns.get(normalizeHeader("Нижний юнит"))!;
  const chassis: GeneratorChassisInput[] = [];
  for (let rowNumber = chassisHeader.rowNumber + 1; rowNumber <= chassisSheet.rowCount; rowNumber += 1) {
    const row = chassisSheet.getRow(rowNumber);
    const name = cellText(row, chassisNameColumn);
    if (!name) continue;
    const rackName = cellText(row, chassisRackColumn);
    const position = cellNumber(row, chassisPositionColumn, "Нижний юнит", rowNumber);
    if (!Number.isInteger(position) || position < 1) throw new Error(`В строке ${rowNumber} листа Chassis указан некорректный нижний юнит.`);
    chassis.push({ name, rackName, position });
  }
  if (chassis.length === 0) throw new Error("На листе Chassis нет размещения устройств.");
  if (new Set(chassis.map((item) => normalize(item.name))).size !== chassis.length) throw new Error("На листе Chassis повторяются устройства.");

  return { specificationDevices, ignoredItems, racks, chassis };
}

function deviceTypeTokens(specName: string): string[] {
  const name = normalize(specName);
  if (name === "сервер спфс" || name === "сервер спхд") return ["Default Server 1U"];
  if (name === "байпас оптический is401u") return ["IS401U"];
  return [specName.replace(/^(байпас оптический|балансировщик|пак|сервер|коммутатор|криптошлюз)\s+/iu, "").trim()];
}

function roleNamesForDevice(specName: string, isOdf: boolean): string[] {
  if (isOdf) return ["ODF оператора"];
  const name = normalize(specName);
  if (name.startsWith("байпас оптический")) return ["Комбинированный байпас", "Пассивный байпас", "Байпас"];
  if (name.startsWith("балансировщик")) return ["Балансировщик"];
  if (name.startsWith("пак ")) return ["Фильтр"];
  if (name.startsWith("сервер спфс")) return ["Сервер СПФС", "Сервер"];
  if (name.startsWith("сервер спхд")) return ["Сервер СПХД", "Сервер"];
  if (name.startsWith("сервер")) return ["Сервер"];
  if (name.startsWith("коммутатор")) return ["Коммутатор"];
  if (name.startsWith("криптошлюз")) return ["Криптошлюз"];
  return [];
}

function matchDeviceType(tokens: string[], types: NetboxDeviceType[]): { type?: NetboxDeviceType; matchedToken: string; ambiguous: boolean } {
  for (const token of tokens) {
    const key = normalize(token);
    const exact = types.filter((type) => normalize(type.model) === key || normalize(type.slug ?? "") === key);
    if (exact.length === 1) return { type: exact[0], matchedToken: token, ambiguous: false };
    if (exact.length > 1) return { matchedToken: token, ambiguous: true };
    const matches = types.filter((type) => normalize(type.model).includes(key) || key.includes(normalize(type.model)));
    if (matches.length === 1) return { type: matches[0], matchedToken: token, ambiguous: false };
    if (matches.length > 1) return { matchedToken: token, ambiguous: true };
  }
  return { matchedToken: tokens[0] ?? "", ambiguous: false };
}

function matchRole(names: string[], roles: NetboxDeviceRole[]): NetboxDeviceRole | undefined {
  for (const name of names) {
    const exact = roles.find((role) => normalize(role.name) === normalize(name));
    if (exact) return exact;
  }
  return undefined;
}

export function buildSiteGeneratorPlan(
  parsed: ParsedSiteGeneratorFiles,
  deviceTypes: NetboxDeviceType[],
  deviceRoles: NetboxDeviceRole[],
  genericManufacturer: NetboxManufacturer | undefined,
  locations: NetboxLocation[],
  existingRacks: NetboxRack[],
  siteId: number
): SiteGeneratorPlan {
  const errors: string[] = [];
  const rackByKey = new Map(parsed.racks.map((rack) => [normalize(rack.name), rack]));
  const existingRackNames = new Set(existingRacks.filter((rack) => rack.site?.id === undefined || rack.site.id === siteId).map((rack) => normalize(rack.name)));
  for (const rack of parsed.racks) if (existingRackNames.has(normalize(rack.name))) errors.push(`Стойка «${rack.name}» уже существует на площадке.`);

  const expected = new Map<string, { name: string; specName: string; isOdf: boolean; height: number }>();
  for (const item of parsed.specificationDevices) {
    for (let index = 1; index <= item.quantity; index += 1) {
      const name = `${item.name} (${index})`;
      expected.set(normalize(name), { name, specName: item.name, isOdf: false, height: item.height });
    }
  }

  const placements: GeneratorDevicePlan[] = [];
  const chassisOnlyDevices: string[] = [];
  const deviceTypesToCreate = new Map<string, { model: string; height: number; manufacturerId?: number }>();
  let manufacturerToCreate = false;
  const occupied = new Map<string, { start: number; end: number; name: string }[]>();
  const roomsWithoutLocation: string[] = [];
  for (const chassis of parsed.chassis) {
    const rack = rackByKey.get(normalize(chassis.rackName));
    if (!rack) {
      errors.push(`Для устройства «${chassis.name}» не найдена стойка «${chassis.rackName}» на листе Racks.`);
      continue;
    }
    let item = expected.get(normalize(chassis.name));
    const isOdf = !item && /^odf\b/iu.test(chassis.name);
    if (!item && !isOdf) {
      errors.push(`Устройство «${chassis.name}» из Chassis отсутствует в спецификации и не распознано как ODF.`);
      continue;
    }
    if (item) expected.delete(normalize(chassis.name));
    const typeTokens = isOdf ? ["ODF 1U"] : deviceTypeTokens(item!.specName);
    const { type: deviceType, matchedToken: typeToken, ambiguous } = matchDeviceType(typeTokens, deviceTypes);
    if (!deviceType) {
      if (ambiguous) {
        errors.push(`Для типа «${typeToken}» найдено несколько совпадений в NetBox. Уточните тип вручную.`);
        continue;
      }
      if (!genericManufacturer) manufacturerToCreate = true;
      const requestedHeight = isOdf ? 1 : item!.height;
      const modelKey = normalize(typeToken);
      const existingPlan = deviceTypesToCreate.get(modelKey);
      if (existingPlan && existingPlan.height !== requestedHeight) {
        errors.push(`Для типа «${typeToken}» в спецификации указана разная высота.`);
        continue;
      }
      deviceTypesToCreate.set(modelKey, { model: typeToken, height: requestedHeight, ...(genericManufacturer ? { manufacturerId: genericManufacturer.id } : {}) });
    }
    const role = matchRole(roleNamesForDevice(isOdf ? "ODF" : item!.specName, isOdf), deviceRoles);
    if (!role) {
      errors.push(`Не найдена роль NetBox для устройства «${chassis.name}».`);
      continue;
    }
    const height = deviceType ? Number(deviceType.u_height) : (isOdf ? 1 : item!.height);
    if (!Number.isInteger(height) || height < 1) {
      errors.push(`Для типа «${deviceType?.model ?? typeToken}» не задана положительная высота.`);
      continue;
    }
    if (chassis.position + height - 1 > rack.height) {
      errors.push(`Устройство «${chassis.name}» не помещается в стойку «${rack.name}» высотой ${rack.height}U.`);
      continue;
    }
    const slotKey = normalize(rack.name);
    const intervals = occupied.get(slotKey) ?? [];
    const end = chassis.position + height - 1;
    const overlap = intervals.find((interval) => chassis.position <= interval.end && end >= interval.start);
    if (overlap) {
      errors.push(`Устройства «${chassis.name}» и «${overlap.name}» пересекаются в стойке «${rack.name}».`);
      continue;
    }
    intervals.push({ start: chassis.position, end, name: chassis.name });
    occupied.set(slotKey, intervals);
    placements.push({ name: chassis.name, ...(deviceType ? { deviceTypeId: deviceType.id } : {}), deviceTypeModel: typeToken, deviceRoleId: role.id, height, rackName: rack.name, position: chassis.position });
    if (isOdf) chassisOnlyDevices.push(chassis.name);
  }
  if (expected.size > 0) errors.push(`В Chassis не найдено размещение для устройств: ${[...expected.values()].map((item) => item.name).slice(0, 8).join(", ")}${expected.size > 8 ? ` и ещё ${expected.size - 8}` : ""}.`);
  const resolvedRacks = parsed.racks.map((rack) => {
    const location = rack.room ? locations.find((item) => item.site?.id === siteId && normalize(item.name) === normalize(rack.room)) : undefined;
    if (rack.room && !location) roomsWithoutLocation.push(rack.room);
    return { ...rack, ...(location ? { locationId: location.id } : {}) };
  });
  if (errors.length) throw new Error(errors.join(" "));
  return { racks: resolvedRacks, devices: placements, deviceTypesToCreate: [...deviceTypesToCreate.values()], manufacturerToCreate, ignoredItems: parsed.ignoredItems, chassisOnlyDevices, roomsWithoutLocation: [...new Set(roomsWithoutLocation)] };
}
