import { useEffect, useRef, type ReactNode } from "react";

type ModalProps = {
  /** id элемента с заголовком окна: он же уходит в aria-labelledby. */
  labelledBy: string;
  onDismiss: () => void;
  children: ReactNode;
};

const FOCUSABLE = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

function focusableWithin(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((element) => !element.hasAttribute("disabled"));
}

/**
 * Оболочка модального окна: затемнение, карточка, Escape, клик по фону и
 * удержание фокуса внутри. Появление анимируется через `@starting-style`
 * в styles.css, для этого JavaScript не нужен. Исчезновение мгновенное —
 * чтобы его анимировать, пришлось бы держать узел в DOM после закрытия.
 */
export default function Modal({ labelledBy, onDismiss, children }: ModalProps) {
  const overlayRef = useRef<HTMLDivElement>(null);
  // Обработчику клавиш всегда нужен свежий onDismiss, но переподписывать
  // слушатель на каждый рендер нельзя: тогда фокус прыгал бы на первый элемент.
  const dismissRef = useRef(onDismiss);

  useEffect(() => {
    dismissRef.current = onDismiss;
  }, [onDismiss]);

  useEffect(() => {
    const overlay = overlayRef.current;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    // Фокус на первой кнопке: она в обоих окнах это «Отмена», то есть
    // действие, которое ничего не ломает.
    focusableWithin(overlay ?? document.body)[0]?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        dismissRef.current();
        return;
      }
      if (event.key !== "Tab" || !overlay) return;
      const focusable = focusableWithin(overlay);
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      // Возвращаем фокус на кнопку, которая открыла окно.
      previousFocus?.focus();
    };
  }, []);

  return (
    <div
      className="dialog-overlay"
      ref={overlayRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby={labelledBy}
      onMouseDown={(event) => { if (event.target === event.currentTarget) onDismiss(); }}
    >
      <div className="dialog-box">{children}</div>
    </div>
  );
}