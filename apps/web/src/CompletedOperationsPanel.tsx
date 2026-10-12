import { useEffect, useState } from "react";
import { AlertCircle, ArrowRight, CheckCircle2, ClipboardCheck, Clock3, LoaderCircle } from "lucide-react";
import { apiFetch } from "./apiClient";
import Modal from "./Modal";
import OperationSites from "./OperationSites";

type OperationType = "ASSIGN" | "REMOVE" | "COMMENT" | "WORK_CHECK";
type OperationStatus = "SUCCEEDED" | "PARTIAL" | "FAILED";

type RecentOperation = {
  id: string;
  type: OperationType;
  status: OperationStatus;
  total: number;
  completed: number;
  failed: number;
  message: string | null;
  finishedAt: string;
  expiresAt: string;
};

type OperationDetail = {
  id: string;
  type: OperationType;
  status: OperationStatus;
  total: number;
  completed: number;
  failed: number;
  message: string | null;
  errorDetails?: unknown;
  items: {
    siteId: string;
    status: string;
    errorMessage: string | null;
    label: string;
    rowNumber: number | null;
    comment: string | null;
    commentedAt: string | null;
    resultMessage: string | null;
  }[];
};

const titles: Record<OperationType, string> = {
  ASSIGN: "Назначить инженера",
  REMOVE: "Снять с площадки",
  COMMENT: "Написать комментарий",
  WORK_CHECK: "Проверить работы"
};

const statusLabels: Record<OperationStatus, string> = {
  SUCCEEDED: "Выполнено",
  PARTIAL: "Завершено с ошибками",
  FAILED: "Не выполнено"
};

function formatRemaining(expiresAt: string, now: number) {
  const seconds = Math.max(0, Math.ceil((new Date(expiresAt).getTime() - now) / 1000));
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

function formatDate(value: string) {
  return new Date(value).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
}

export default function CompletedOperationsPanel() {
  const [operations, setOperations] = useState<RecentOperation[]>([]);
  const [loadError, setLoadError] = useState("");
  const [now, setNow] = useState(Date.now());
  const [selectedId, setSelectedId] = useState("");
  const [detail, setDetail] = useState<OperationDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const response = await apiFetch("/api/operations/recent", { cache: "no-store" });
        const data = await response.json() as { items?: RecentOperation[]; error?: string };
        if (!response.ok) throw new Error(data.error ?? "Не удалось загрузить завершённые операции.");
        if (active) {
          setOperations(data.items ?? []);
          setLoadError("");
        }
      } catch (reason) {
        if (active) {
          setOperations([]);
          setLoadError(reason instanceof Error ? reason.message : "Не удалось загрузить завершённые операции.");
        }
      }
    };
    void load();
    const pollTimer = window.setInterval(() => void load(), 10_000);
    const clockTimer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => {
      active = false;
      window.clearInterval(pollTimer);
      window.clearInterval(clockTimer);
    };
  }, []);

  useEffect(() => {
    if (!selectedId) return;
    const controller = new AbortController();
    setLoading(true);
    setDetail(null);
    setError("");
    void apiFetch(`/api/operations/${encodeURIComponent(selectedId)}`, { signal: controller.signal, cache: "no-store" })
      .then(async (response) => {
        const data = await response.json() as OperationDetail & { error?: string };
        if (!response.ok) throw new Error(data.error ?? "Результат операции больше недоступен.");
        setDetail(data);
      })
      .catch((reason: unknown) => {
        if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "Не удалось загрузить результат.");
      })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [selectedId]);

  const visibleOperations = operations.filter((operation) => new Date(operation.expiresAt).getTime() > now);
  return (
    <>
      {visibleOperations.length > 0 && <section className="overview-active-panel completed-operations-panel" aria-label="Выполненные операции">
        <div className="section-heading">
          <h2>Выполненные операции</h2>
          <p>Результаты доступны в течение 10 минут после завершения.</p>
        </div>
        {loadError ? (
          <p className="completed-operations-empty completed-operations-error">{loadError}</p>
        ) : (
          <div className="overview-active-list">
            {visibleOperations.map((operation) => (
              <button className="overview-active-card completed-operation-card" key={operation.id} onClick={() => setSelectedId(operation.id)}>
                <span className={`overview-active-icon completed-operation-icon completed-operation-${operation.status.toLowerCase()}`}>
                  {operation.status === "SUCCEEDED" ? <CheckCircle2 size={17} /> : operation.status === "FAILED" ? <AlertCircle size={17} /> : <ClipboardCheck size={17} />}
                </span>
                <span className="overview-active-copy">
                  <strong>{titles[operation.type]}</strong>
                  <small>{statusLabels[operation.status]} · {operation.completed} / {operation.total} · {formatDate(operation.finishedAt)}</small>
                </span>
                <span className="completed-operation-expiry"><Clock3 size={13} /> {formatRemaining(operation.expiresAt, now)}</span>
                <span className="overview-active-open">Результат <ArrowRight size={14} /></span>
              </button>
            ))}
          </div>
        )}
      </section>}

      {selectedId && (
        <Modal className="completed-operation-dialog" labelledBy="completed-operation-title" onDismiss={() => { setSelectedId(""); setDetail(null); setError(""); }}>
          <div className="modal-heading">
            <span className="modal-icon"><ClipboardCheck size={17} /></span>
            <div>
              <h2 id="completed-operation-title">{detail ? titles[detail.type] : "Результат операции"}</h2>
              <p>{detail ? statusLabels[detail.status] : "Недавно выполненный сценарий"}</p>
            </div>
          </div>
          <div className="completed-operation-dialog-body">
            {loading && <div className="admin-loading"><LoaderCircle size={16} className="template-spinner" /> Загружаем результат…</div>}
            {error && <div className="admin-feedback admin-feedback-error"><AlertCircle size={15} />{error}</div>}
            {detail && (
              <>
                <p className="completed-operation-summary">{detail.message ?? `${detail.completed} обработано · ${detail.failed} ошибок`}</p>
                {detail.type === "WORK_CHECK" ? (
                  <div className="completed-work-check-table-wrap">
                    <table className="work-check-table">
                      <thead><tr><th>Площадка</th><th>Последний комментарий</th><th>Написано</th></tr></thead>
                      <tbody>
                        {detail.items.map((item) => (
                          <tr key={item.siteId}>
                            <td>{item.label}</td>
                            <td className={item.comment ? "" : "work-check-empty-comment"}>{item.comment ?? item.resultMessage ?? item.errorMessage ?? "—"}</td>
                            <td className={item.commentedAt ? "work-check-comment-time" : "work-check-empty-comment"}>
                              {item.commentedAt ? new Date(item.commentedAt).toLocaleString("ru-RU", { dateStyle: "short", timeStyle: "short" }) : "—"}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <OperationSites items={detail.items} labelColumn="Данные" labels={Object.fromEntries(detail.items.map((item) => [item.siteId, item.label]))} />
                )}
              </>
            )}
          </div>
          <div className="modal-actions">
            <button type="button" className="btn-primary" onClick={() => { setSelectedId(""); setDetail(null); setError(""); }}>Закрыть</button>
          </div>
        </Modal>
      )}
    </>
  );
}
