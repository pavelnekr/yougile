function normalizeHeader(header: string) {
  return header.normalize("NFKC").trim().toLocaleLowerCase("ru").replace(/[^a-zа-яё0-9]/gi, "");
}

function getField(rawData: unknown, name: string) {
  if (!rawData || typeof rawData !== "object" || Array.isArray(rawData)) return "";

  const field = Object.entries(rawData).find(([header]) => normalizeHeader(header) === normalizeHeader(name))?.[1];
  return typeof field === "string" ? field.trim() : "";
}

function formatDate(date: Date) {
  const day = String(date.getUTCDate()).padStart(2, "0");
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  return `${day}.${month}.${date.getUTCFullYear()}`;
}

function nextDateRange(value: string) {
  const match = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(value);
  if (!match) return value;

  const [, dayText, monthText, yearText] = match;
  const day = Number(dayText);
  const month = Number(monthText);
  const year = Number(yearText);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return value;
  }

  date.setUTCDate(date.getUTCDate() + 1);
  return `${value}-${formatDate(date)}`;
}

export function renderCommentTemplate(template: string, rawData: unknown) {
  const time = getField(rawData, "time");
  let data = getField(rawData, "data");
  const day = getField(rawData, "day").toLocaleLowerCase("ru");

  if (data && day === "ночь") data = nextDateRange(data);

  return template
    .replaceAll("${time}", time || "${time}")
    .replaceAll("${data}", data || "${data}");
}
