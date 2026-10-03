import { useEffect, type RefObject } from "react";

/**
 * Прокручивает карточку к панели, которая только что появилась или сменилась:
 * новый шаг не должен оставаться за липкой шапкой. Высота шапки учтена в
 * `scroll-margin-top` у целевых панелей в styles.css.
 *
 * `key` — имя текущего шага (`"rows"`, `"preview"`, `"operation"` и т. п.) либо
 * `null`, когда шага ещё нет. Он меняется ровно на переходах между шагами,
 * поэтому прокрутка срабатывает один раз на шаг, а не на каждый рендер.
 * `target` в зависимости не нужен: это стабильный ref, `.current` читается
 * внутри эффекта уже после того, как панель появилась в DOM.
 */
export function useStepScroll(key: string | null, target: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const element = key ? target.current : null;
    if (!element) return;

    const frame = requestAnimationFrame(() => {
      element.scrollIntoView({ behavior: "smooth", block: "start" });
    });
    return () => cancelAnimationFrame(frame);
  }, [key]);
}