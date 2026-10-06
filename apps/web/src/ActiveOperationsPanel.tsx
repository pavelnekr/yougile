import { useEffect, useState } from "react";
import { Activity, ArrowRight } from "lucide-react";
import { fetchActiveOperations, type ActiveOperation } from "./activeOperations";
import type { Section } from "./router";

const operationTitles: Record<ActiveOperation["type"], string> = {
  ASSIGN: "Назначение инженеров",
  REMOVE: "Снятие инженеров",
  COMMENT: "Отправка комментариев"
};

const operationSections: Record<ActiveOperation["type"], Section> = {
  ASSIGN: "Назначить инженера",
  REMOVE: "Снять инженеров",
  COMMENT: "Написать комментарий"
};

/**
 * Панель «Идёт операция» на обзоре. Запущенные работы выполняются в фоне,
 * даже когда пользователь ушёл с их страницы; карточка показывает тип операции,
 * счётчик и прогресс. Клик открывает сценарий — страница сама восстанавливает
 * панель хода по активной операции и показывает то, что было закрыто.
 */
export default function ActiveOperationsPanel({ onNavigate }: { onNavigate: (section: Section) => void }) {
  const [operations, setOperations] = useState<ActiveOperation[]>([]);

  useEffect(() => {
    let active = true;
    let timeout: ReturnType<typeof setTimeout>;

    const poll = async () => {
      try {
        const items = await fetchActiveOperations();
        if (active) setOperations(items);
      } catch {
        // API недоступен — оставляем последнее известное состояние панели.
      }
      if (active) timeout = setTimeout(poll, 2000);
    };

    void poll();
    return () => {
      active = false;
      clearTimeout(timeout);
    };
  }, []);

  if (operations.length === 0) return null;

  return (
    <section className="overview-active-panel" aria-label="Активные операции">
      <div className="section-heading">
        <h2>Идёт операция</h2>
        <p>Работа продолжается в фоне. Откройте сценарий, чтобы следить за ходом.</p>
      </div>
      <div className="overview-active-list">
        {operations.map((operation) => {
          const ratio = operation.total > 0 ? operation.completed / operation.total : 0.02;
          return (
            <button
              className="overview-active-card"
              key={operation.id}
              onClick={() => onNavigate(operationSections[operation.type])}
            >
              <span className="overview-active-icon">
                <Activity size={17} />
              </span>
              <span className="overview-active-copy">
                <strong>{operationTitles[operation.type]}</strong>
                <small>
                  {operation.status === "QUEUED" ? "В очереди" : "Выполняется"} · {operation.completed} / {operation.total}
                </small>
              </span>
              <span className="overview-active-track">
                <i style={{ transform: `scaleX(${ratio})` }} />
              </span>
              <span className="overview-active-open">
                Открыть <ArrowRight size={14} />
              </span>
            </button>
          );
        })}
      </div>
    </section>
  );
}