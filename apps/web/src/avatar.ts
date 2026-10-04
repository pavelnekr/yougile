// Первый знак для аватара.
//
// slice(0, 1) здесь не годится: у эмодзи и составных символов (ZWJ-последовательности,
// флаги, суррогатные пары) первый кодовый элемент — это половина символа. В кружке
// появляется ромб со знаком вопроса, то есть U+FFFD. Intl.Segmenter отдаёт целый
// графемный кластер — ровно то, что человек видит в имени.
//
// Отдельный модуль, потому что аватар рисуют и история операций, и шапка портала,
// а правило должно быть одно: иначе через полгода эти два места разъедутся.

let segmenter: Intl.Segmenter | null | undefined;

function graphemeSegmenter(): Intl.Segmenter | null {
  if (segmenter !== undefined) return segmenter;
  try {
    segmenter = new Intl.Segmenter("ru", { granularity: "grapheme" });
  } catch {
    // Старый браузер без Intl.Segmenter — работаем по кодовым точкам.
    segmenter = null;
  }
  return segmenter;
}

export function avatarInitial(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return "";

  const active = graphemeSegmenter();
  if (active) {
    // Segments — итерируемый объект, а не итератор, поэтому раскрываем его
    // через spread, а не через next().
    const first = [...active.segment(trimmed)][0]?.segment;
    if (first) return first.toLocaleUpperCase("ru");
  }

  // Фолбэк: Array.from идёт по кодовым точкам и не режет суррогатную пару.
  const firstCodePoint = Array.from(trimmed)[0];
  return firstCodePoint ? firstCodePoint.toLocaleUpperCase("ru") : "";
}