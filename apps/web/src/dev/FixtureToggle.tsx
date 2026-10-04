import type { FixtureMode } from "./worstCase";

const SEGMENTS: { mode: FixtureMode; label: string }[] = [
  { mode: "demo", label: "Обычные данные" },
  { mode: "worst", label: "Худший случай" },
  { mode: "empty", label: "Пусто" },
  { mode: "huge", label: "1000+" }
];

// Переключатель наборов данных для break-ui. Служебный элемент: держится
// поверх внизу по центру, серый трек и белая подвижка, без анимации —
// переключение мгновенное, содержимое не должно ездить.
export default function FixtureToggle({
  mode,
  onChange
}: {
  mode: FixtureMode;
  onChange: (mode: FixtureMode) => void;
}) {
  if (!import.meta.env.DEV) return null;
  return (
    <div className="fixture-toggle" role="group" aria-label="Набор данных для проверки">
      {SEGMENTS.map((segment) => (
        <button
          key={segment.mode}
          type="button"
          className={mode === segment.mode ? "fixture-toggle-active" : ""}
          aria-pressed={mode === segment.mode}
          onClick={() => onChange(segment.mode)}
        >
          {segment.label}
        </button>
      ))}
    </div>
  );
}