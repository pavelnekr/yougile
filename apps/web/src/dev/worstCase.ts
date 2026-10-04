// Фикстуры «худший случай» для break-ui. Живут только в dev-сборке: страницы
// грузят этот модуль через динамический import() под защитой
// import.meta.env.DEV. В продакшне ветка недостижима — readMode() всегда
// возвращает "demo", когда DEV равен false, — поэтому браузер этот модуль не
// запрашивает. Сам компонент переключателя из бандла вырезается полностью,
// а данные остаются отдельным ленивым чанком (проверено сборкой: ~12 КБ файла
// рядом с главным, запроса к нему в production нет).
//
// Значения взяты из CATALOG.md и ограничений, которые нашлись в проекте:
// fileName обрезается до 255 символов (imports/routes.ts), поиск в истории
// ограничен 100 символами (history/routes.ts), остальные строки в Postgres
// не ограничены — Prisma String это text.

export type FixtureMode = "demo" | "worst" | "empty" | "huge";

export type FixtureSummary = {
  period: "30" | "90" | "all";
  totals: {
    uploads: number;
    operations: number;
    assignmentOperations: number;
    assignments: number;
    removals: number;
    commentOperations: number;
    comments: number;
    successfulItems: number;
    failedItems: number;
    pendingOperations: number;
  };
  activity: { key: string; label: string; uploads: number; assignments: number; removals: number; comments: number }[];
  users: { name: string; uploads: number; operations: number; assignments: number; removals: number; comments: number }[];
  engineers: { name: string; assignments: number; removals: number }[];
  // Сервер отдаёт эти счётчики, когда список усечён: в интерфейсе под таблицами
  // появляется строка «показаны N из M». Без них худший режим не проверял бы
  // собственную новую плашку.
  usersTotal?: number;
  engineersTotal?: number;
  engineerNamesAvailable: boolean;
  recentUploads: { fileName: string; rowCount: number; status: string; createdAt: string; uploadedBy: string }[];
  uploadRetentionNote: string;
};

export type FixtureItem = {
  id: string;
  operationId: string;
  type: "ASSIGN" | "REMOVE" | "COMMENT";
  status: "PENDING" | "SUCCEEDED" | "FAILED" | "SKIPPED";
  operationStatus: string;
  siteId: string;
  engineer: string;
  address: string | null;
  rowNumber: number | null;
  fileName: string | null;
  comment: string | null;
  user: string;
  error: string | null;
  createdAt: string;
};

export type FixtureRecords = { page: number; pageSize: number; total: number; items: FixtureItem[] };

export type FixtureBatch = {
  id: string;
  fileName: string;
  rowCount: number;
  uploadedBy: string;
  createdAt: string;
  status: "PREVIEW" | "ASSIGNING" | "COMPLETE";
};

export type FixtureDetails = FixtureBatch & {
  sheetName: string | null;
  columns: string[];
  // Сервер обрезает содержимое батча и сообщает, сколько строк прислал, а
  // сколько есть в базе. Фикстура повторяет это, иначе худший режим не
  // проверял бы собственную плашку «показаны первые N строк».
  rowsShown?: number;
  rowsTotal?: number;
  rowsTruncated?: boolean;
  rows: {
    rowNumber: number;
    siteId: string | null;
    address: string | null;
    engineerName: string | null;
    status: string;
    rawData: Record<string, unknown>;
  }[];
};

// ─── Имена из CATALOG.md ──────────────────────────────────────────────────────
// Эмодзи первым: slice(0, 1) режет суррогатную пару пополам.
// ZWJ-последовательность из 7 кодовых единиц.
// Диакритика внахлёст, CJK без пробелов, RTL, апострофы, частицы внизу.
const NAMES = [
  "🦊 Fox",
  "👩🏽‍💻 Priya",
  "Aleksandra Wiśniewska-Kowalczyk",
  "Konstantin Oberhauser-Wettstein",
  "Đặng Thị Ngọc Hân",
  "Ólafur Darri Ólafsson",
  "王秀英",
  "نور الهدى عبد الرحمن",
  "Seán O'Brien-Ó Súilleabháin",
  "María José de la Cruz y Fernández",
  "dana",
  "Jo",
  "J",
  "pavel@you-gile.company.ru",
  "Локальный оператор",
  "Константин Оберхаузер-Веттштайн-Северо-Западного-Федерального-Округа"
];

// Инженеры. Порядок отсортирован по обоим видам работ, как это теперь делает
// сервер, и обрезан десятью. У «Сидорова» снятий больше, чем максимум
// назначений у кого-либо: пока делителем полос служил только максимум
// назначений, полоса снятия уезжала за 100%, налезала на счётчик и растягивала
// страницу по горизонтали. ENGINEERS_TOTAL больше длины списка, поэтому
// видна плашка «показаны 10 из 34».
const ENGINEERS_TOTAL = 34;
const ENGINEERS = [
  { name: "Коников Роман", assignments: 480, removals: 12 },
  { name: "Иванов Иван", assignments: 120, removals: 4 },
  { name: "Aleksandra Wiśniewska-Kowalczyk", assignments: 40, removals: 18 },
  { name: "Инженер не указан", assignments: 22, removals: 30 },
  { name: "Сидоров Сидор", assignments: 18, removals: 700 },
  { name: "sam.lee@yougile.ru", assignments: 12, removals: 4 },
  { name: "王秀英", assignments: 6, removals: 2 },
  { name: "9f8e7d6c-5b4a-4c3d-8e2f-1a0b9c8d7e6f", assignments: 5, removals: 2 },
  { name: "Đặng Thị Ngọc Hân", assignments: 3, removals: 9 },
  { name: "Ólafur Darri Ólafsson", assignments: 2, removals: 0 }
];

// Обрезанное сервером имя файла длиной ровно 255 символов.
const FILE_NAME_255 =
  ("Q3 Board Deck — FINAL (revised) v12 [approved by legal] " +
    "для филиала Санкт-Петербург и юго-западный округ — " +
    "поставка в два этапа с раздельной приёмкой и хранением на складе " +
    "ответственного хранения до конца квартала (повторная сборка от 14.02.2026")
    .slice(0, 240) + ".xlsx";

const FILE_NAMES = [
  FILE_NAME_255,
  "IMG_20250914_183022_HDR_portrait_edited_edited.HEIC",
  "Q3 Board Deck — FINAL (revised) v12 [approved by legal].pdf",
  "выгрузка_по_площадкам_за_сентябрь_сводная_итоговая_финальная_версия_2.xlsx",
  "план.xlsx"
];

const UNBREAKABLE_MAP_URL =
  "https://example.com/workspaces/acme/projects/q3-launch/docs/9f8e7d6c5b4a?tab=comments&filter=unresolved";
const LONG_ERROR =
  "YouGile API вернул 403: доступ к задаче запрещён для текущего пользователя, площадка числится за другим кластером, повторите назначение после согласования с руководителем";
const LONG_COMMENT =
  "Проверьте, пожалуйста, состояние площадки и вывезенное оборудование до конца смены. " +
  "Если доступ закрыт — оставьте заявку в чате и отметьте здесь, чтобы координатор увидел. " +
  "Повторяем этот текст намеренно: шаблон комментария в реальной работе может быть длинным, " +
  "и в таблице журнала он должен обрезаться, а не растягивать колонку или высоту строки.";

const RETENTION_NOTE =
  "История XLSX хранит только последние пять файлов; статистика загрузок учитырует только сохранившиеся файлы.";

function at(day: string) {
  return `${day}T${(day.charCodeAt(6) % 12) + 10}:24:00.000Z`;
}

// ─── Строка журнала ───────────────────────────────────────────────────────────

type ItemSeed = Partial<FixtureItem> & Pick<FixtureItem, "id" | "type" | "status" | "siteId">;

function item(seed: ItemSeed): FixtureItem {
  return {
    operationId: `op${seed.id}`,
    operationStatus: "SUCCEEDED",
    engineer: "Иванов Иван",
    address: "Москва, ул. Тверская, д. 1",
    rowNumber: 12,
    fileName: "план.xlsx",
    comment: null,
    user: "Иванова Мария",
    error: null,
    createdAt: "2026-10-02T09:24:00.000Z",
    ...seed
  };
}

function worstRecords(page: number, pageSize: number): FixtureRecords {
  const rows: FixtureItem[] = [
    // 1 — UUID вместо номера, неразрывная ссылка в адресе, ошибка в одиннадцать строк.
    item({
      id: "r01", type: "ASSIGN", status: "FAILED",
      siteId: "9f8e7d6c-5b4a-4c3d-8e2f-1a0b9c8d7e6f",
      address: UNBREAKABLE_MAP_URL, fileName: FILE_NAME_255, error: LONG_ERROR,
      user: "👩🏽‍💻 Priya", createdAt: "2026-10-04T08:24:00.000Z"
    }),
    // 2 — обычная строка, чтобы сравнивать с худшей.
    item({ id: "r02", type: "ASSIGN", status: "SUCCEEDED", siteId: "1234" }),
    // 3 — ведущие нули и перенос строки внутри ячейки.
    item({
      id: "r03", type: "REMOVE", status: "SUCCEEDED", siteId: "00001234",
      address: "Санкт-Петербург, пр-т Лиговский\nд. 50, литера А", engineer: "  Sam   Lee ",
      fileName: "IMG_20250914_183022_HDR_portrait_edited_edited.HEIC"
    }),
    // 4 — комментарий на 2000 знаков.
    item({
      id: "r04", type: "COMMENT", status: "SUCCEEDED", siteId: "1235",
      comment: LONG_COMMENT.repeat(2), engineer: "", fileName: "Q3 Board Deck — FINAL (revised) v12 [approved by legal].pdf"
    }),
    // 5 — в очереди, файла нет: на его месте прочерк.
    item({
      id: "r05", type: "ASSIGN", status: "PENDING", siteId: "1236",
      fileName: null, user: "🦊 Fox", createdAt: "2026-10-04T09:24:00.000Z"
    }),
    // 6 — без изменений, инженер не распознан.
    item({ id: "r06", type: "REMOVE", status: "SKIPPED", siteId: "1237", engineer: "Инженер не указан", address: null }),
    // 7 — аудитория без фикстуры: имя из одной буквы.
    item({ id: "r07", type: "ASSIGN", status: "SUCCEEDED", siteId: "1238", user: "J", engineer: "J" }),
    // 8 — ошибка без текста: всплывающая подсказка окажется пустой.
    item({ id: "r08", type: "ASSIGN", status: "FAILED", siteId: "1239", error: "", engineer: "Jo", user: "Jo" }),
    // 9 — очень длинное имя файла без единого пробела.
    item({
      id: "r09", type: "ASSIGN", status: "SUCCEEDED", siteId: "1240",
      fileName: "выгрузка_по_площадкам_за_сентябрь_сводная_итоговая_финальная_версия_2.xlsx",
      engineer: "王秀英", user: "王秀英"
    }),
    // 10 — ошибка на две строки.
    item({
      id: "r10", type: "COMMENT", status: "FAILED", siteId: "1241",
      error: "Комментарий не отправлен: чат задачи закрыт\nОбновите статус и повторите",
      comment: "Проверьте оборудование", user: "Aleksandra Wiśniewska-Kowalczyk"
    }),
    // 11 — дата в будущем.
    item({ id: "r11", type: "ASSIGN", status: "PENDING", siteId: "1242", createdAt: "2027-03-01T00:00:00.000Z" }),
    // 12 — нулевая отметка времени.
    item({ id: "r12", type: "ASSIGN", status: "SUCCEEDED", siteId: "1243", createdAt: "1970-01-01T00:00:00.000Z" }),
    // 13 — три года назад, вне окна в 30 дней.
    item({ id: "r13", type: "REMOVE", status: "SUCCEEDED", siteId: "1244", createdAt: "2023-04-05T11:24:00.000Z" }),
    // 14 — все диакритики разом.
    item({ id: "r14", type: "ASSIGN", status: "SUCCEEDED", siteId: "1245", engineer: "Ólafur Darri Ólafsson", user: "Ólafur Darri Ólafsson" }),
    // 15 — RTL.
    item({ id: "r15", type: "ASSIGN", status: "SUCCEEDED", siteId: "1246", engineer: "نور الهدى عبد الرحمن", user: "نور الهدى عبد الرحمن" }),
    // 16 — апострофы и частицы внизу.
    item({ id: "r16", type: "ASSIGN", status: "SUCCEEDED", siteId: "1247", engineer: "María José de la Cruz y Fernández" }),
    // 17 — имя в нижнем регистре целиком.
    item({ id: "r17", type: "ASSIGN", status: "SUCCEEDED", siteId: "1248", user: "dana" }),
    // 18 — локальный оператор рядом с именами.
    item({ id: "r18", type: "ASSIGN", status: "SUCCEEDED", siteId: "1249", user: "Локальный оператор" }),
    // 19 — вьетнамские диакритики внахлёст.
    item({ id: "r19", type: "REMOVE", status: "SUCCEEDED", siteId: "1250", engineer: "Đặng Thị Ngọc Hân" }),
    // 20 — составное кириллическое имя.
    item({
      id: "r20", type: "ASSIGN", status: "SUCCEEDED", siteId: "1251",
      user: "Константин Оберхаузер-Веттштайн-Северо-Западного-Федерального-Округа"
    }),
    // 21 — номер строки отсутствует.
    item({ id: "r21", type: "ASSIGN", status: "SUCCEEDED", siteId: "1252", rowNumber: null }),
    // 22 — номер строки огромный.
    item({ id: "r22", type: "ASSIGN", status: "SUCCEEDED", siteId: "1253", rowNumber: 12345678 }),
    // 23 — HTML и markdown внутри данных: должны остаться текстом.
    item({
      id: "r23", type: "COMMENT", status: "SUCCEEDED", siteId: "1254",
      comment: "<script>alert(1)</script> &amp; **жирный** «кавычки»", engineer: ""
    }),
    // 24 — площадка из одних пробелов не должна превращаться в пустую ячейку.
    item({ id: "r24", type: "ASSIGN", status: "SUCCEEDED", siteId: "   ", address: "   " }),
    // 25 — CJK в адресе.
    item({ id: "r25", type: "ASSIGN", status: "SUCCEEDED", siteId: "1255", address: "北京市朝阳区建国路88号SOHO现代城A座1201室" })
  ];

  const total = rows.length + 1; // 26, чтобы вторая страница держала одну строку
  const offset = (page - 1) * pageSize;
  return { page, pageSize, total, items: rows.slice(offset, offset + pageSize) };
}

// ─── Сводка ───────────────────────────────────────────────────────────────────

function activityBuckets(count: number, huge: boolean) {
  const buckets = [];
  for (let index = 0; index < count; index += 1) {
    const day = String(1 + (index % 28)).padStart(2, "0");
    const month = String(1 + (index % 12)).padStart(2, "0");
    // Один ведёт себя нормально, у соседа всё по нулям, у третьего миллион.
    const spike = huge && index === count - 1;
    buckets.push({
      key: `2026-${month}-${day}`,
      label: index % 3 === 0 ? `${day}.${month}` : `${month}.2026`,
      uploads: spike ? 1000000 : index % 5 === 0 ? 3 : 0,
      assignments: spike ? 999999 : index % 4 === 0 ? 57 : 0,
      removals: index % 7 === 0 ? 227 : 0,
      comments: index % 11 === 0 ? 1 : 0
    });
  }
  return buckets;
}

function worstSummary(): FixtureSummary {
  return {
    period: "30",
    totals: {
      uploads: 5,
      operations: 23,
      assignmentOperations: 1,
      assignments: 1284,
      removals: 3400,
      commentOperations: 1,
      comments: 12345678,
      successfulItems: 0,
      failedItems: 1000000,
      pendingOperations: 1
    },
    activity: activityBuckets(30, true),
    users: NAMES.map((name, index) => ({
      name,
      uploads: index % 3,
      operations: index,
      assignments: index * 1284,
      removals: index === 0 ? 1000000 : 0,
      comments: index === 1 ? 1 : 0
    })),
    // NAMES короче лимита, поэтому под таблицей участников в худшем режиме
    // плашки не будет — она проверяется в huge, где список действительно обрезан.
    usersTotal: 1284,
    engineers: ENGINEERS,
    engineersTotal: ENGINEERS_TOTAL,
    engineerNamesAvailable: true,
    recentUploads: FILE_NAMES.map((fileName, index) => ({
      fileName,
      rowCount: [0, 1, 1284, 1000000, 12345678][index],
      status: ["PREVIEW", "ASSIGNING", "COMPLETE", "COMPLETE", "COMPLETE"][index],
      createdAt: at(`2026-10-0${index + 1}`),
      uploadedBy: NAMES[index]
    })),
    uploadRetentionNote: RETENTION_NOTE
  };
}

function emptySummary(): FixtureSummary {
  return {
    ...worstSummary(),
    totals: {
      uploads: 0, operations: 0, assignmentOperations: 0, assignments: 0, removals: 0,
      commentOperations: 0, comments: 0, successfulItems: 0, failedItems: 0, pendingOperations: 0
    },
    activity: [],
    users: [],
    usersTotal: 0,
    engineers: [],
    engineersTotal: 0,
    recentUploads: []
  };
}

function hugeSummary(): FixtureSummary {
  const base = worstSummary();
  // 1284 участника рабочего пространства. Сервер отдаёт первые USERS_LIMIT
  // и счётчик usersTotal, поэтому и фикстура повторяет именно это: раньше
  // приходили все 1284 строк, документ вырастал до 54 тысяч пикселей и
  // переставал прокручиваться.
  const allUsers = Array.from({ length: 1284 }, (_, index) => ({
    name: `${NAMES[index % NAMES.length]} №${index}`,
    uploads: index % 2,
    operations: index,
    assignments: index,
    removals: index % 3,
    comments: 0
  }));
  return {
    ...base,
    users: allUsers.slice(0, 25),
    usersTotal: allUsers.length,
    activity: activityBuckets(90, true)
  };
}

// ─── Аудит XLSX ───────────────────────────────────────────────────────────────

const AUDIT_COLUMNS = [
  "id_site",
  "address",
  "user",
  "comment",
  "comment2",
  "data",
  "day",
  "time",
  "klaster",
  "Benachrichtigungseinstellungen",
  "",
  "Колонка без пробелов и с длинным названием которое никто не сокращал",
  "столбец_с_подчёркиваниями_который_не_имеет_точек_переноса_в_браузере"
];

function auditRows(count: number) {
  const rows = [];
  for (let index = 0; index < count; index += 1) {
    const rowNumber = index + 1;
    if (index === 0) {
      // Объекты ExcelJS: гиперссылка и форматированный текст.
      rows.push({
        rowNumber, siteId: "1234", address: "Москва, ул. Тверская, д. 1",
        engineerName: "Иванов Иван", status: "READY",
        rawData: {
          id_site: "1234",
          address: { text: "Открыть в картах", hyperlink: UNBREAKABLE_MAP_URL },
          user: { richText: [{ text: "Площадка " }, { text: "12А", font: { bold: true } }] },
          comment: LONG_COMMENT.slice(0, 300),
          data: "2026-09-14T18:30:22.000Z",
          day: null,
          time: 0.1 + 0.2,
          klaster: false
        }
      });
      continue;
    }
    if (index === 1) {
      // Пустые значения: null, пустая строка и одни пробелы — все в «—».
      rows.push({
        rowNumber, siteId: null, address: null, engineerName: null, status: "INVALID_ROW",
        rawData: { id_site: "", address: "   ", user: null, comment: "", data: "", day: null, time: "", klaster: null }
      });
      continue;
    }
    if (index === 2) {
      // Экранирование: текст должен остаться текстом.
      rows.push({
        rowNumber, siteId: "9999", address: "<script>alert(1)</script>", engineerName: "**жирный**",
        status: "SITE_NOT_FOUND",
        rawData: {
          id_site: "9999",
          address: "<script>alert(1)</script>",
          user: "&amp; &#39;кавычки&#39; &laquo;ёлочки&raquo;",
          comment: "**жирный** _курсив_ `код`",
          data: "Line one\nLine two\tTabbed",
          day: "🧑‍🔧 Иван", time: "王秀英", klaster: "نور الهدى"
        }
      });
      continue;
    }
    if (index === 3) {
      // Числа на границах форматирования.
      rows.push({
        rowNumber, siteId: "0001", address: "Крайние значения", engineerName: "12345678.9", status: "READY",
        rawData: {
          id_site: "0001", address: "Крайние значения", user: "-42.5",
          comment: "0.1 + 0.2 = " + (0.1 + 0.2),
          data: 1000000, day: 1284, time: 0, klaster: "∞"
        }
      });
      continue;
    }
    rows.push({
      rowNumber,
      siteId: String(1000 + index),
      address: `Москва, ул. Примерная, д. ${index % 200 + 1}, кв. ${index % 50 + 1}`,
      engineerName: NAMES[index % NAMES.length],
      status: ["READY", "SITE_NOT_FOUND", "ENGINEER_NOT_FOUND", "INVALID_ROW", "DUPLICATE_SITE"][index % 5],
      rawData: {
        id_site: String(1000 + index),
        address: `Москва, ул. Примерная, д. ${index % 200 + 1}, кв. ${index % 50 + 1}`,
        user: NAMES[index % NAMES.length],
        comment: index % 6 === 0 ? LONG_COMMENT : `Обычный комментарий ${index}`,
        data: `2026-09-${String(1 + index % 28).padStart(2, "0")}`,
        day: String(1 + index % 28).padStart(2, "0"),
        time: `${String(index % 24).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}`,
        klaster: index % 3 === 0 ? "Фильтры" : "Балансеры"
      }
    });
  }
  return rows;
}

function auditBatches(): FixtureBatch[] {
  return [
    {
      id: "b1", fileName: FILE_NAME_255, rowCount: 1000000,
      uploadedBy: "👩🏽‍💻 Priya", createdAt: "2027-03-01T00:00:00.000Z", status: "ASSIGNING"
    },
    {
      id: "b2", fileName: "IMG_20250914_183022_HDR_portrait_edited_edited.HEIC", rowCount: 1284,
      uploadedBy: "Aleksandra Wiśniewska-Kowalczyk", createdAt: "1970-01-01T00:00:00.000Z", status: "COMPLETE"
    },
    {
      id: "b3", fileName: "Q3 Board Deck — FINAL (revised) v12 [approved by legal].pdf", rowCount: 0,
      uploadedBy: "  Sam   Lee ", createdAt: "2023-04-05T11:24:00.000Z", status: "PREVIEW"
    },
    {
      id: "b4", fileName: "выгрузка_по_площадкам_за_сентябрь_сводная_итоговая_финальная_версия_2.xlsx", rowCount: 1,
      uploadedBy: "نور الهدى عبد الرحمن", createdAt: "2026-10-04T08:24:00.000Z", status: "COMPLETE"
    },
    {
      id: "b5", fileName: "план.xlsx", rowCount: 12345678,
      uploadedBy: "Локальный оператор", createdAt: "2026-10-02T09:24:00.000Z", status: "COMPLETE"
    }
  ];
}

// Сколько строк батча показывает сервер. Дальше содержимое не отдаётся: на
// 1200 строках таблица превращалась в 37 тысяч ячеек и растягивала документ
// до 33 тысяч пикселей.
const DETAIL_ROW_LIMIT = 300;

function auditDetails(batches: FixtureBatch[], rows: number, columns: string[]): FixtureDetails {
  const shown = Math.min(rows, DETAIL_ROW_LIMIT);
  return {
    ...batches[0],
    sheetName: "Лист1 — сентябрь 2026 (итог)",
    columns,
    rowsShown: shown,
    rowsTotal: rows,
    rowsTruncated: rows > shown,
    rows: auditRows(shown)
  };
}

// ─── Точка входа для страниц ──────────────────────────────────────────────────

export async function loadHistoryFixture(mode: FixtureMode) {
  if (mode === "demo") return null;
  if (mode === "empty") {
    const summary = emptySummary();
    return { summary, records: { page: 1, pageSize: 25, total: 0, items: [] } as FixtureRecords };
  }
  if (mode === "huge") {
    const summary = hugeSummary();
    return { summary, records: worstRecords(1, 25) };
  }
  return { summary: worstSummary(), records: worstRecords(1, 25) };
}

export async function loadAuditFixture(mode: FixtureMode) {
  if (mode === "demo") return null;
  if (mode === "empty") {
    const batch: FixtureBatch = {
      id: "b0", fileName: "план.xlsx", rowCount: 0, uploadedBy: "Локальный оператор",
      createdAt: "2026-10-02T09:24:00.000Z", status: "PREVIEW"
    };
    return {
      items: [] as FixtureBatch[],
      details: { ...batch, sheetName: "Лист1", columns: ["id_site", "address"], rows: [] } as FixtureDetails
    };
  }
  if (mode === "huge") {
    const batches = auditBatches();
    const columns = Array.from({ length: 30 }, (_, index) => `column_${index + 1}`);
    return { items: batches, details: auditDetails(batches, 1200, columns) };
  }
  const batches = auditBatches();
  return { items: batches, details: auditDetails(batches, 60, AUDIT_COLUMNS) };
}