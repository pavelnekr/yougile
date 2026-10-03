import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertCircle, CheckCircle2, Clock3, FileSpreadsheet, RefreshCw, Rows3 } from "lucide-react";

type ImportBatch = {
  id: string;
  fileName: string;
  rowCount: number;
  uploadedBy: string;
  createdAt: string;
  status: "PREVIEW" | "ASSIGNING" | "COMPLETE";
};
type ImportDetails = ImportBatch & {
  sheetName: string | null;
  columns: string[];
  rows: {
    rowNumber: number;
    siteId: string | null;
    address: string | null;
    engineerName: string | null;
    status: string;
    rawData: Record<string, unknown>;
  }[];
};

const preferredColumns = ["data", "day", "time", "id_site", "address", "comment", "user", "comment2", "klaster"];

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Не удалось загрузить данные аудита.";
}

function formatDate(value: string) {
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? date.toLocaleString("ru-RU", { dateStyle: "medium", timeStyle: "short" })
    : "Дата неизвестна";
}

function cellText(value: unknown) {
  if (value === null || value === undefined) return "—";
  if (typeof value === "string") return value.trim() || "—";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

function statusLabel(status: ImportBatch["status"]) {
  if (status === "COMPLETE") return "Завершена";
  if (status === "ASSIGNING") return "В обработке";
  return "Загружена";
}

function normalizeColumnName(name: string) {
  return name.normalize("NFKC").trim().toLocaleLowerCase("ru").replace(/[^a-zа-яё0-9]/gi, "");
}

export default function ImportAuditPage() {
  const [items, setItems] = useState<ImportBatch[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [details, setDetails] = useState<ImportDetails | null>(null);
  const [loadingList, setLoadingList] = useState(true);
  const [loadingDetails, setLoadingDetails] = useState(false);
  const [error, setError] = useState("");
  const [listError, setListError] = useState("");
  const [page, setPage] = useState(1);
  const detailsRequestId = useRef(0);
  const pageSize = 8;

  const loadBatches = useCallback(async (signal?: AbortSignal) => {
    setLoadingList(true);
    setListError("");
    try {
      const response = await fetch("/api/imports", { signal });
      const data = await response.json() as { items?: ImportBatch[]; error?: string };
      if (!response.ok) throw new Error(data.error ?? "Не удалось загрузить историю XLSX.");
      if (!data.items) throw new Error("Сервер не вернул список загрузок.");
      setItems(data.items);
    } catch (reason) {
      if (signal?.aborted) return;
      setListError(errorMessage(reason));
    } finally {
      if (!signal?.aborted) setLoadingList(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void loadBatches(controller.signal);
    return () => controller.abort();
  }, [loadBatches]);

  const openBatch = async (batch: ImportBatch) => {
    const requestId = ++detailsRequestId.current;
    setSelectedId(batch.id);
    setDetails(null);
    setError("");
    setLoadingDetails(true);
    try {
      const response = await fetch(`/api/imports/${encodeURIComponent(batch.id)}`);
      const data = await response.json() as ImportDetails & { error?: string };
      if (!response.ok) throw new Error(data.error ?? "Не удалось загрузить содержимое XLSX.");
      if (detailsRequestId.current !== requestId) return;
      setDetails(data);
    } catch (reason) {
      if (detailsRequestId.current !== requestId) return;
      setError(errorMessage(reason));
    } finally {
      if (detailsRequestId.current === requestId) setLoadingDetails(false);
    }
  };

  const visibleItems = items.slice((page - 1) * pageSize, page * pageSize);
  const pageCount = Math.max(1, Math.ceil(items.length / pageSize));
  const columns = useMemo(() => {
    if (!details) return [];
    const priority = new Map(preferredColumns.map((column, index) => [normalizeColumnName(column), index]));
    return details.columns
      .map((column, index) => ({ column, index, priority: priority.get(normalizeColumnName(column)) }))
      .sort((left, right) => {
        if (left.priority !== undefined && right.priority !== undefined) return left.priority - right.priority;
        if (left.priority !== undefined) return -1;
        if (right.priority !== undefined) return 1;
        return left.index - right.index;
      })
      .map(({ column }) => column);
  }, [details]);

  return (
    <section className="section-view import-audit-page">
      <div className="eyebrow"><span className="eyebrow-line" /> ЖУРНАЛ ЗАГРУЗОК</div>
      <div className="section-hero">
        <span className="section-hero-icon"><FileSpreadsheet size={22} /></span>
        <div><h1>Аудит XLSX</h1><p>История загруженных файлов и исходные данные каждой строки плана.</p></div>
      </div>

      <section className="panel import-audit-list-panel">
        <div className="panel-heading">
          <div><h2>Загруженные файлы</h2><p>{items.length ? `Храним последние ${items.length} загрузок` : "Имя файла, кто и когда его загрузил"}</p></div>
          <button className="text-button import-audit-refresh" disabled={loadingList} onClick={() => void loadBatches()}>
            <RefreshCw size={13} className={loadingList ? "audit-refreshing" : ""} /> Обновить
          </button>
        </div>

        {listError ? (
          <div className="import-audit-message import-audit-message-error"><AlertCircle size={16} />{listError}</div>
        ) : loadingList ? (
          <div className="import-audit-message">Загружаем историю XLSX…</div>
        ) : items.length === 0 ? (
          <div className="import-audit-empty"><FileSpreadsheet size={22} /><strong>Загрузок пока нет</strong><span>Загруженные XLSX-файлы появятся здесь.</span></div>
        ) : (
          <>
            <div className="import-audit-table-wrap">
              <table className="import-audit-table">
                <thead><tr><th>Файл</th><th>Загрузил</th><th>Дата и время</th><th>Строк</th><th>Статус</th></tr></thead>
                <tbody>
                  {visibleItems.map((item) => (
                    <tr key={item.id} className={selectedId === item.id ? "import-audit-row-selected" : ""} onClick={() => void openBatch(item)} aria-selected={selectedId === item.id}>
                      <td><span className="import-audit-file"><FileSpreadsheet size={16} /><strong title={item.fileName}>{item.fileName}</strong></span></td>
                      <td>{item.uploadedBy}</td>
                      <td><span className="import-audit-date"><Clock3 size={13} />{formatDate(item.createdAt)}</span></td>
                      <td>{item.rowCount.toLocaleString("ru-RU")}</td>
                      <td><span className={`import-audit-status import-audit-status-${item.status.toLowerCase()}`}>{item.status === "COMPLETE" && <CheckCircle2 size={12} />}{statusLabel(item.status)}</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="sites-pagination import-audit-pagination">
              <span>Показано {(page - 1) * pageSize + 1}–{Math.min(page * pageSize, items.length)} из {items.length}</span>
              <div><button disabled={page <= 1} onClick={() => setPage(page - 1)}>Назад</button><span>{page} / {pageCount}</span><button disabled={page >= pageCount} onClick={() => setPage(page + 1)}>Вперёд</button></div>
            </div>
          </>
        )}
      </section>

      <section className="panel import-audit-details-panel">
        <div className="panel-heading">
          <div>
            <h2>{details ? details.fileName : "Содержимое XLSX"}</h2>
            <p>{details ? `${details.sheetName ? `Лист «${details.sheetName}» · ` : ""}${details.rowCount} строк · ${details.uploadedBy} · ${formatDate(details.createdAt)}` : "Выберите файл в верхнем блоке, чтобы просмотреть его строки"}</p>
          </div>
          {details && <span className="import-details-row-count"><Rows3 size={14} /> {details.rows.length}</span>}
        </div>
        {error ? (
          <div className="import-audit-message import-audit-message-error"><AlertCircle size={16} />{error}</div>
        ) : loadingDetails ? (
          <div className="import-audit-message">Загружаем содержимое файла…</div>
        ) : details ? (
          <div className="import-details-table-wrap">
            <table className="import-details-table">
              <thead><tr><th className="import-details-row-number">№</th>{columns.map((column) => <th key={column}>{column}</th>)}</tr></thead>
              <tbody>
                {details.rows.map((row) => (
                  <tr key={row.rowNumber}>
                    <td className="import-details-row-number">{row.rowNumber}</td>
                    {columns.map((column) => <td key={column} title={cellText(row.rawData[column])}>{cellText(row.rawData[column])}</td>)}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="import-audit-empty import-audit-empty-details"><Rows3 size={22} /><strong>Таблица появится здесь</strong><span>Выберите XLSX-файл в списке выше.</span></div>
        )}
      </section>
      <footer className="page-footer"><span>YouGile Operations Portal <span className="footer-version">v0.1</span></span><span>История загрузок XLSX</span></footer>
    </section>
  );
}
