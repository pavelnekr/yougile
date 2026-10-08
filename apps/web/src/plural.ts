// Русские числовые формы слова: 1 площадка, 2 площадки, 5 площадок.
// Форму выбирает Intl.PluralRules, поэтому исключения 11–14 и числа с дробной
// частью считать вручную не нужно. Список форм один на проект: словарь маленький,
// а рядом с числом в интерфейсе почти всегда стоит одно из этих слов.

const pluralRules = new Intl.PluralRules("ru-RU");

/** Три формы слова по числу: 1 площадка, 2 площадки, 5 площадок. */
export type PluralForms = [one: string, few: string, many: string];

export const siteForms: PluralForms = ["площадка", "площадки", "площадок"];
export const rowForms: PluralForms = ["строка", "строки", "строк"];
export const uploadForms: PluralForms = ["загрузка", "загрузки", "загрузок"];
export const operationForms: PluralForms = ["операция", "операции", "операций"];
export const recordForms: PluralForms = ["запись", "записи", "записей"];
export const taskForms: PluralForms = ["активная задача", "активные задачи", "активных задач"];
export const engineerForms: PluralForms = ["инженер", "инженера", "инженеров"];
export const participantForms: PluralForms = ["участник", "участника", "участников"];
export const adminForms: PluralForms = ["администратор", "администратора", "администраторов"];
export const columnForms: PluralForms = ["столбец", "столбца", "столбцов"];
export const recipientForms: PluralForms = ["получатель", "получателя", "получателей"];
export const equipmentForms: PluralForms = ["позиция", "позиции", "позиций"];
export const stepForms: PluralForms = ["этап", "этапа", "этапов"];
export const letterForms: PluralForms = ["письмо", "письма", "писем"];
// У прилагательных, употреблённых как существительные, вторая и третья формы
// совпадают: и «2 активных», и «5 активных» — родительный множественного.
export const activeForms: PluralForms = ["активный", "активных", "активных"];
export const blockedForms: PluralForms = ["заблокированный", "заблокированных", "заблокированных"];

function formatNumber(value: number): string {
  return value.toLocaleString("ru-RU");
}

/**
 * Форма слова для числа: pluralRu(2, siteForms) вернёт "площадки".
 * Нужна, когда само число уже свёрстано отдельно, например в <strong>.
 */
export function pluralRu(count: number, forms: PluralForms): string {
  if (!Number.isFinite(count)) return forms[2];
  const category = pluralRules.select(count);
  if (category === "one") return forms[0];
  if (category === "few") return forms[1];
  return forms[2];
}

/** «5 площадок» — отформатированное число вместе с формой слова. */
export function countRu(count: number, forms: PluralForms): string {
  return `${formatNumber(count)} ${pluralRu(count, forms)}`;
}