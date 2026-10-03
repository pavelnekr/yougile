import { useEffect, useRef, useState } from "react";
import { AlertCircle, Clock3, FileSpreadsheet, RefreshCw, Upload } from "lucide-react";
import { useStepScroll } from "./useStepScroll";
import { apiFetch } from "./apiClient";

type ImportBatch = {
  id: string;
  fileName: string;
  rowCount: number;
  uploadedBy: string;
  createdAt: string;
  status: "PREVIEW" | "ASSIGNING" | "COMPLETE";
};
type WorkCheckItem = {
  rowNumber: number;
  siteId: string | null;
  comment: string | null;
  message: string;
};
type CheckedFile = {
  id: string;
  fileName: string;
  rowCount: number;
};

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Не удалось проверить работы.";
}

function formatDate(value: string) {
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? date.toLocaleString("ru-RU", { dateStyle: "medium", timeStyle: "short" })
    : "Дата неизвестна";
}

export default function XlsxWorkCheckPage() {
  const [source, setSource] = useState<"upload" | "history">("upload");
  const [batches, setBatches] = useState<ImportBatch[]>([]);
  const [loadingBatches, setLoadingBatches] = useState(true);
  const [batchError, setBatchError] = useState("");
  const [checkedFile, setCheckedFile] = useState<CheckedFile | null>(null);
  const [items, setItems] = useState<WorkCheckItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const resultsStepRef = useRef<HTMLElement>(null);
  useStepScroll(checkedFile ? "results" : null, resultsStepRef);

  const loadBatches = async (signal?: AbortSignal) => {
    setLoadingBatches(true);
    setBatchError("");
    try {
      const response = await apiFetch("/api/imports", { signal });
      const data = await response.json() as { items?: ImportBatch[]; error?: string };
      if (!response.ok) throw new Error(data.error ?? "Не удалось загрузить историю XLSX.");
      if (!data.items) throw new Error("Сервер не вернул историю XLSX.");
      setBatches(data.items);
    } catch (reason) {
      if (!signal?.aborted) setBatchError(errorMessage(reason));
    } finally {
      if (!signal?.aborted) setLoadingBatches(false);
    }
  };

  useEffect(() => {
    const controller = new AbortController();
    void loadBatches(controller.signal);
    return () => controller.abort();
  }, []);

  const checkFile = async (file: CheckedFile, rowNumbers: number[]) => {
    setCheckedFile(file);
    setItems([]);
    setError("");
    if (rowNumbers.length === 0) {
      setError("В выбранном XLSX нет строк для проверки.");
      return;
    }
    setBusy(true);
    try {
      const response = await apiFetch(`/api/imports/${encodeURIComponent(file.id)}/work-check`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rowNumbers })
      });
      const data = await response.json() as { items?: WorkCheckItem[]; error?: string };
      if (!response.ok) throw new Error(data.error ?? "Не удалось получить последние комментарии.");
      if (!data.items) throw new Error("Сервер не вернул результаты проверки.");
      setItems(data.items);
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusy(false);
    }
  };

  const reset = () => {
    setCheckedFile(null);
    setItems([]);
    setError("");
  };

  const uploadWorkbook = async (file: File) => {
    setBusy(true);
    setError("");
    reset();
    try {
      const body = new FormData();
      body.append("file", file);
      const response = await apiFetch("/api/imports/preview", { method: "POST", body });
      const data = await response.json() as {
        importId?: string;
        fileName?: string;
        rows?: { rowNumber: number }[];
        error?: string;
      };
      if (!response.ok) throw new Error(data.error ?? "Не удалось прочитать XLSX.");
      if (!data.importId || !data.fileName || !data.rows) throw new Error("Сервер вернул неполные данные XLSX.");
      await checkFile(
        { id: data.importId, fileName: data.fileName, rowCount: data.rows.length },
        data.rows.map((row) => row.rowNumber)
      );
      void loadBatches();
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusy(false);
    }
  };

  const selectBatch = async (batch: ImportBatch) => {
    setBusy(true);
    setError("");
    reset();
    try {
      const response = await apiFetch(`/api/imports/${encodeURIComponent(batch.id)}`);
      const data = await response.json() as {
        id?: string;
        fileName?: string;
        rowCount?: number;
        rows?: { rowNumber: number }[];
        error?: string;
      };
      if (!response.ok) throw new Error(data.error ?? "Не удалось загрузить выбранный XLSX.");
      if (!data.id || !data.fileName || !data.rows) throw new Error("Сервер вернул неполные данные XLSX.");
      await checkFile(
        { id: data.id, fileName: data.fileName, rowCount: data.rowCount ?? data.rows.length },
        data.rows.map((row) => row.rowNumber)
      );
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="section-view assignment-page work-check-page">
      <div className="eyebrow"><span className="eyebrow-line" /> ПРОВЕРКА РАБОТ ПО XLSX</div>
      <div className="sites-page-heading">
        <div><h1>Проверить работы</h1><p>Последние комментарии в задачах YouGile для площадок из выбранного XLSX.</p></div>
        {checkedFile && <span className="sites-total">{items.length || checkedFile.rowCount} строк</span>}
      </div>

      {error && <div className="assignment-error"><AlertCircle size={15} />{error}</div>}

      {!checkedFile ? (
        <>
          <div className="removal-source-switch" role="tablist" aria-label="Источник XLSX">
            <button className={source === "upload" ? "removal-source-active" : ""} role="tab" aria-selected={source === "upload"} onClick={() => { setSource("upload"); reset(); }}>
              <Upload size={15} /> Загрузить XLSX
            </button>
            <button className={source === "history" ? "removal-source-active" : ""} role="tab" aria-selected={source === "history"} onClick={() => { setSource("history"); reset(); }}>
              <Clock3 size={15} /> Выбрать из аудита
            </button>
          </div>
          {source === "upload" ? (
            <div className="panel xlsx-upload-panel removal-upload-panel">
              <div className="xlsx-upload-icon"><FileSpreadsheet size={23} /></div>
              <h2>Загрузите XLSX-план</h2>
              <p>Для каждой площадки покажем последнее сообщение из чата её задачи в YouGile.</p>
              <label className={`xlsx-dropzone ${busy ? "xlsx-dropzone-busy" : ""}`}>
                <Upload size={20} />
                <strong>{busy ? "Загружаем файл и проверяем работы…" : "Выберите файл .xlsx"}</strong>
                <span>{busy ? "Пожалуйста, подождите" : "Номер площадки будет сопоставлен с задачей YouGile"}</span>
                <input type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" disabled={busy} onChange={(event) => {
                  const file = event.currentTarget.files?.[0];
                  event.currentTarget.value = "";
                  if (file) void uploadWorkbook(file);
                }} />
              </label>
            </div>
          ) : (
            <section className="panel removal-history-panel">
              <div className="panel-heading">
                <div><h2>Файлы из аудита</h2><p>Выберите XLSX, по которому нужно проверить комментарии.</p></div>
                <button className="text-button" disabled={loadingBatches} onClick={() => void loadBatches()}><RefreshCw size={13} /> Обновить</button>
              </div>
              {batchError ? <div className="import-audit-message import-audit-message-error"><AlertCircle size={15} />{batchError}</div>
                : loadingBatches ? <div className="import-audit-message">Загружаем историю XLSX…</div>
                  : batches.length === 0 ? <div className="import-audit-empty"><FileSpreadsheet size={22} /><strong>Загрузок пока нет</strong><span>Сначала загрузите XLSX в аудите или здесь.</span></div>
                    : <div className="removal-history-list">
                      {batches.map((batch) => (
                        <button className="removal-history-item" key={batch.id} disabled={busy} onClick={() => void selectBatch(batch)}>
                          <span className="xlsx-file-icon"><FileSpreadsheet size={17} /></span>
                          <span className="removal-history-file"><strong title={batch.fileName}>{batch.fileName}</strong><small>{batch.rowCount} строк · {formatDate(batch.createdAt)} · {batch.uploadedBy}</small></span>
                          <span className={`import-audit-status import-audit-status-${batch.status.toLowerCase()}`}>{batch.status === "COMPLETE" ? "Завершена" : batch.status === "ASSIGNING" ? "В обработке" : "Загружена"}</span>
                        </button>
                      ))}
                    </div>}
            </section>
          )}
        </>
      ) : (
        <section className="panel work-check-results" ref={resultsStepRef}>
          <div className="panel-heading">
            <div><h2>Результаты проверки</h2><p>{checkedFile.fileName} · последние сообщения из чатов задач YouGile</p></div>
            <button className="text-button" disabled={busy} onClick={reset}>Выбрать другой XLSX</button>
          </div>
          {busy ? (
            <div className="import-audit-message"><RefreshCw size={15} className="audit-refreshing" /> Получаем последние комментарии из YouGile…</div>
          ) : items.length > 0 ? (
            <div className="work-check-table-wrap">
              <table className="work-check-table">
                <thead><tr><th>Номер площадки</th><th>Последний комментарий</th></tr></thead>
                <tbody>
                  {items.map((item) => (
                    <tr key={`${item.rowNumber}-${item.siteId ?? "unknown"}`}>
                      <td>{item.siteId ?? "—"}</td>
                      <td className={item.comment ? "" : "work-check-empty-comment"}>{item.comment ?? item.message}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : !error ? (
            <div className="import-audit-empty"><FileSpreadsheet size={22} /><strong>Строки для проверки не найдены</strong></div>
          ) : null}
        </section>
      )}
      <footer className="page-footer"><span>YouGile Operations Portal <span className="footer-version">v0.1</span></span><span>Источник проверки — выбранный XLSX</span></footer>
    </section>
  );
}
