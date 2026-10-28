import { useEffect, useRef, useState } from "react";
import { AlertCircle, Clock3, FileSpreadsheet, RefreshCw, Upload } from "lucide-react";
import { useStepScroll } from "./useStepScroll";
import { apiFetch } from "./apiClient";
import { fetchActiveOperations } from "./activeOperations";
import { countRu, rowForms, siteForms } from "./plural";
import { PORTAL_VERSION } from "./version";

type ImportBatch = {
  id: string;
  fileName: string;
  rowCount: number;
  uploadedBy: string;
  createdAt: string;
  status: "PREVIEW" | "ASSIGNING" | "COMPLETE";
};
type WorkCheckItem = {
  fileName?: string;
  rowNumber: number;
  siteId: string | null;
  comment: string | null;
  /** Время написания последнего комментария (ISO), если YouGile его вернул. */
  commentedAt: string | null;
  message: string;
};
type WorkCheckProgress = {
  total: number;
  processed: number;
  startedAt: number | null;
  finishedAt: number | null;
  remainingMs: number | null;
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

function formatRemaining(ms: number): string {
  const seconds = Math.max(Math.ceil(ms / 1000), 1);
  if (seconds < 60) return `≈ ${seconds} сек`;
  return `≈ ${Math.round(seconds / 60)} мин`;
}

export default function XlsxWorkCheckPage() {
  const [source, setSource] = useState<"upload" | "history">("upload");
  const [batches, setBatches] = useState<ImportBatch[]>([]);
  const [selectedBatchIds, setSelectedBatchIds] = useState<string[]>([]);
  const [loadingBatches, setLoadingBatches] = useState(true);
  const [batchError, setBatchError] = useState("");
  const [checkedFile, setCheckedFile] = useState<CheckedFile | null>(null);
  const [items, setItems] = useState<WorkCheckItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [progress, setProgress] = useState<WorkCheckProgress | null>(null);
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

  useEffect(() => {
    const controller = new AbortController();
    const restoreActiveCheck = async () => {
      try {
        const activeChecks = await fetchActiveOperations(controller.signal);
        const activeCheck = activeChecks.find((operation) => operation.type === "WORK_CHECK");
        if (!activeCheck?.importId) return;

        setSource("history");
        setCheckedFile({
          id: activeCheck.importId,
          fileName: activeCheck.fileName ?? "Проверка работ",
          rowCount: activeCheck.total
        });
        setBusy(true);

        while (!controller.signal.aborted) {
          const progressResponse = await apiFetch(
            `/api/imports/work-check/progress?checkId=${encodeURIComponent(activeCheck.id)}`,
            { signal: controller.signal, cache: "no-store" }
          );
          if (progressResponse.ok) {
            const nextProgress = await progressResponse.json() as WorkCheckProgress;
            if (nextProgress.total > 0) setProgress(nextProgress);
          }

          const currentChecks = await fetchActiveOperations(controller.signal);
          if (!currentChecks.some((operation) => operation.id === activeCheck.id)) {
            // Проверка сохраняет итоговую Operation до снятия активной метки.
            // Коротко опрашиваем последние результаты, чтобы сразу показать таблицу.
            for (let attempt = 0; attempt < 5 && !controller.signal.aborted; attempt += 1) {
              const recentResponse = await apiFetch("/api/operations/recent", {
                signal: controller.signal,
                cache: "no-store"
              });
              if (recentResponse.ok) {
                const recent = await recentResponse.json() as { items?: { id: string; type: string; finishedAt: string | null; importId?: string | null }[] };
                const result = recent.items?.find((operation) =>
                  operation.type === "WORK_CHECK" &&
                  operation.importId === activeCheck.importId &&
                  operation.finishedAt &&
                  (!activeCheck.startedAt || new Date(operation.finishedAt).getTime() >= new Date(activeCheck.startedAt).getTime())
                );
                if (result) {
                  const detailResponse = await apiFetch(`/api/operations/${encodeURIComponent(result.id)}`, {
                    signal: controller.signal,
                    cache: "no-store"
                  });
                  if (detailResponse.ok) {
                    const detail = await detailResponse.json() as { items?: { label: string; rowNumber: number | null; comment: string | null; commentedAt: string | null; resultMessage: string | null }[] };
                    setItems((detail.items ?? []).map((item) => ({
                      rowNumber: item.rowNumber ?? 0,
                      siteId: item.label,
                      comment: item.comment,
                      commentedAt: item.commentedAt,
                      message: item.resultMessage ?? "Комментарий не найден."
                    })));
                  }
                  break;
                }
              }
              await new Promise((resolve) => window.setTimeout(resolve, 500));
            }
            setBusy(false);
            setProgress(null);
            break;
          }
          await new Promise((resolve) => window.setTimeout(resolve, 1000));
        }
      } catch (reason) {
        if (!controller.signal.aborted) {
          setError(errorMessage(reason));
          setBusy(false);
        }
      }
    };
    void restoreActiveCheck();
    return () => controller.abort();
  }, []);

  const runCheckFile = async (file: CheckedFile, rowNumbers: number[]): Promise<WorkCheckItem[]> => {
    if (rowNumbers.length === 0) return [];
    // Синхронный POST не отдаёт промежуточные состояния (он идёт ~2 секунды на
    // площадку), поэтому живой прогресс опрашиваем отдельным лёгким запросом,
    // пока основной крутится в фоне.
    const checkId = `wc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
    let finished = false;
    const pollProgress = async () => {
      while (!finished) {
        try {
          const response = await apiFetch(`/api/imports/work-check/progress?checkId=${encodeURIComponent(checkId)}`);
          if (response.ok) {
            const data = await response.json() as WorkCheckProgress;
            if (data.total > 0) setProgress(data);
            if (data.finishedAt !== null) break;
          }
        } catch {
          // Сбой опроса не должен ронять проверку: итог придёт из основного запроса.
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    };
    void pollProgress();

    try {
      const response = await apiFetch(`/api/imports/${encodeURIComponent(file.id)}/work-check`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rowNumbers, checkId })
      });
      const data = await response.json() as { items?: WorkCheckItem[]; error?: string };
      if (!response.ok) throw new Error(data.error ?? "Не удалось получить последние комментарии.");
      if (!data.items) throw new Error("Сервер не вернул результаты проверки.");
      return data.items;
    } catch (reason) {
      throw new Error(errorMessage(reason));
    } finally {
      finished = true;
      setProgress(null);
    }
  };

  const checkFile = async (file: CheckedFile, rowNumbers: number[]) => {
    setCheckedFile(file);
    setItems([]);
    setError("");
    setProgress(null);
    setBusy(true);
    try { setItems(await runCheckFile(file, rowNumbers)); }
    catch (reason) { setError(errorMessage(reason)); }
    finally { setBusy(false); }
  };

  const reset = () => {
    setCheckedFile(null);
    setItems([]);
    setError("");
    setProgress(null);
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

  const selectBatches = async () => {
    const selected = batches.filter((batch) => selectedBatchIds.includes(batch.id));
    if (!selected.length) return;
    setBusy(true);
    setError("");
    reset();
    try {
      const allItems: WorkCheckItem[] = [];
      for (const batch of selected) {
        const response = await apiFetch(`/api/imports/${encodeURIComponent(batch.id)}`);
        const data = await response.json() as { id?: string; fileName?: string; rowCount?: number; rows?: { rowNumber: number }[]; error?: string };
        if (!response.ok) throw new Error(data.error ?? `Не удалось загрузить XLSX «${batch.fileName}».`);
        if (!data.id || !data.fileName || !data.rows) throw new Error(`Сервер вернул неполные данные XLSX «${batch.fileName}».`);
        const part = await runCheckFile({ id: data.id, fileName: data.fileName, rowCount: data.rowCount ?? data.rows.length }, data.rows.map((row) => row.rowNumber));
        allItems.push(...part.map((item) => ({ ...item, fileName: batch.fileName })));
      }
      setCheckedFile({ id: selected[0]!.id, fileName: `${selected.length} XLSX-файла`, rowCount: allItems.length });
      setItems(allItems);
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusy(false);
    }
  };

  const completedRatio = progress && progress.total > 0 ? Math.min(progress.processed / progress.total, 1) : 0;
  const remainingLabel = !progress || progress.total === 0
    ? ""
    : progress.processed >= progress.total
      ? "Собираем результаты…"
      : progress.remainingMs !== null
        ? formatRemaining(progress.remainingMs)
        : "";

  return (
    <section className="section-view assignment-page work-check-page">
      <div className="eyebrow"><span className="eyebrow-line" /> ПРОВЕРКА РАБОТ ПО XLSX</div>
      <div className="sites-page-heading">
        <div><h1>Проверить работы</h1><p>Последние комментарии в задачах YouGile за выбранный период проверки для площадок из выбранного XLSX.</p></div>
        {checkedFile && <span className="sites-total">{countRu(items.length || checkedFile.rowCount, rowForms)}</span>}
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
              <p>Для каждой площадки покажем последнее сообщение из чата её задачи в YouGile за выбранный период проверки (настраивается в «Конфигурации портала»).</p>
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
                <div><h2>Файлы из аудита</h2><p>Отметьте XLSX. Они проверятся по очереди, результаты появятся одним списком.</p></div>
                <button className="text-button" disabled={loadingBatches} onClick={() => void loadBatches()}><RefreshCw size={13} /> Обновить</button>
              </div>
              {batchError ? <div className="import-audit-message import-audit-message-error"><AlertCircle size={15} />{batchError}</div>
                : loadingBatches ? <div className="import-audit-message">Загружаем историю XLSX…</div>
                  : batches.length === 0 ? <div className="import-audit-empty"><FileSpreadsheet size={22} /><strong>Загрузок пока нет</strong><span>Сначала загрузите XLSX в аудите или здесь.</span></div>
                    : <>
                    <div className="removal-history-list">
                      {batches.map((batch) => (
                        <label className="removal-history-item" key={batch.id}>
                          <input type="checkbox" disabled={busy} checked={selectedBatchIds.includes(batch.id)} onChange={() => setSelectedBatchIds((current) => current.includes(batch.id) ? current.filter((id) => id !== batch.id) : [...current, batch.id])} />
                          <span className="xlsx-file-icon"><FileSpreadsheet size={17} /></span>
                          <span className="removal-history-file"><strong title={batch.fileName}>{batch.fileName}</strong><small>{countRu(batch.rowCount, rowForms)} · {formatDate(batch.createdAt)} · {batch.uploadedBy}</small></span>
                          <span className={`import-audit-status import-audit-status-${batch.status.toLowerCase()}`}>{batch.status === "COMPLETE" ? "Завершена" : batch.status === "ASSIGNING" ? "В обработке" : "Загружена"}</span>
                        </label>
                      ))}
                    </div>
                    <div className="import-preview-action"><button className="btn-primary" disabled={busy || selectedBatchIds.length === 0} onClick={() => void selectBatches()}><RefreshCw size={15} />{busy ? "Проверяем файлы по очереди…" : `Проверить выбранные XLSX (${selectedBatchIds.length})`}</button></div>
                    </>}
            </section>
          )}
        </>
      ) : (
        <section className="panel work-check-results" ref={resultsStepRef}>
          <div className="panel-heading">
            <div><h2>Результаты проверки</h2><p>{checkedFile.fileName} · последние сообщения за выбранный период из чатов задач YouGile</p></div>
            <button className="text-button" disabled={busy} onClick={reset}>Выбрать другой XLSX</button>
          </div>
          {busy ? (
            progress && progress.total > 0 ? (
              <div className="work-check-loading" role="progressbar" aria-valuemin={0} aria-valuemax={progress.total} aria-valuenow={Math.min(progress.processed, progress.total)}>
                <div className="operation-progress"><span style={{ transform: `scaleX(${completedRatio})` }} /></div>
                <div className="work-check-progress-meta">
                  <span>Проверено {countRu(progress.processed, siteForms)} из {progress.total}</span>
                  <span>{remainingLabel}</span>
                </div>
              </div>
            ) : (
              <div className="import-audit-message"><RefreshCw size={15} className="audit-refreshing" /> Получаем последние комментарии из YouGile…</div>
            )
          ) : items.length > 0 ? (
            <div className="work-check-table-wrap">
              <table className="work-check-table">
                <thead><tr><th>Файл / площадка</th><th>Последний комментарий</th><th>Написано</th></tr></thead>
                <tbody>
                  {items.map((item) => (
                    <tr key={`${item.fileName ?? ""}-${item.rowNumber}-${item.siteId ?? "unknown"}`}>
                      <td>{item.siteId ?? "—"}{item.fileName && <small className="work-check-source-file">{item.fileName} · строка {item.rowNumber}</small>}</td>
                      <td className={item.comment ? "" : "work-check-empty-comment"}>{item.comment ?? item.message}</td>
                      <td className={item.commentedAt ? "work-check-comment-time" : "work-check-empty-comment"}>
                        {item.commentedAt ? formatDate(item.commentedAt) : "—"}
                      </td>
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
      <footer className="page-footer"><span>YouGile Operations Portal <span className="footer-version">{PORTAL_VERSION}</span></span><span>Источник проверки — выбранный XLSX</span></footer>
    </section>
  );
}
