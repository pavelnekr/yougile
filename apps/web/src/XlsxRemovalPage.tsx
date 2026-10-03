import { useEffect, useMemo, useState } from "react";
import { AlertCircle, CheckCircle2, Clock3, FileSpreadsheet, RefreshCw, ShieldCheck, Upload } from "lucide-react";

type ImportRow = {
  rowNumber: number;
  siteId: string | null;
  address: string | null;
  engineerName: string | null;
  status: string;
};
type ImportBatch = {
  id: string;
  fileName: string;
  rowCount: number;
  uploadedBy: string;
  createdAt: string;
  status: "PREVIEW" | "ASSIGNING" | "COMPLETE";
};
type PlanImport = {
  id: string;
  fileName: string;
  sheetName: string | null;
  rowCount: number;
  rows: ImportRow[];
};
type RemovalPreview = {
  importId: string;
  fileName: string;
  count: number;
  willRemove: number;
  items: {
    rowNumber: number;
    siteId: string;
    address: string | null;
    engineerName: string;
    willRemove: boolean;
    assignedEngineerNames: string[];
    remainingEngineerNames: string[];
  }[];
};
type Operation = {
  id: string;
  type: "ASSIGN" | "REMOVE";
  status: "QUEUED" | "RUNNING" | "SUCCEEDED" | "PARTIAL" | "FAILED" | "CANCELLED";
  total: number;
  completed: number;
  failed: number;
  message: string | null;
  items: { siteId: string; status: string; errorMessage: string | null }[];
};
type Source = "upload" | "history";

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Не удалось выполнить снятие инженеров.";
}

function formatDate(value: string) {
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? date.toLocaleString("ru-RU", { dateStyle: "medium", timeStyle: "short" })
    : "Дата неизвестна";
}

export default function XlsxRemovalPage({ onComplete }: { onComplete: () => void }) {
  const [source, setSource] = useState<Source>("upload");
  const [batches, setBatches] = useState<ImportBatch[]>([]);
  const [loadingBatches, setLoadingBatches] = useState(true);
  const [batchError, setBatchError] = useState("");
  const [planImport, setPlanImport] = useState<PlanImport | null>(null);
  const [selectedRows, setSelectedRows] = useState<number[]>([]);
  const [preview, setPreview] = useState<RemovalPreview | null>(null);
  const [operation, setOperation] = useState<Operation | null>(null);
  const [operationId, setOperationId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const loadBatches = async (signal?: AbortSignal) => {
    setLoadingBatches(true);
    setBatchError("");
    try {
      const response = await fetch("/api/imports", { signal });
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
    if (!operationId) return;
    let active = true;
    let timeout: ReturnType<typeof setTimeout>;

    const poll = async () => {
      try {
        const response = await fetch(`/api/operations/${encodeURIComponent(operationId)}`);
        const data = await response.json() as Operation & { error?: string };
        if (!response.ok) throw new Error(data.error ?? "Не удалось получить результат операции.");
        if (!active) return;
        setOperation(data);
        if (["SUCCEEDED", "PARTIAL", "FAILED"].includes(data.status)) {
          onComplete();
          return;
        }
        timeout = setTimeout(poll, 1200);
      } catch (reason) {
        if (!active) return;
        setError(errorMessage(reason));
        timeout = setTimeout(poll, 2500);
      }
    };

    void poll();
    return () => {
      active = false;
      clearTimeout(timeout);
    };
  }, [operationId, onComplete]);

  const readyRows = useMemo(
    () => planImport?.rows.filter((row) => row.status === "READY" && row.siteId && row.engineerName) ?? [],
    [planImport]
  );
  const selectedReadyRows = readyRows.filter((row) => selectedRows.includes(row.rowNumber));
  const operationPending = Boolean(operationId && (!operation || operation.status === "QUEUED" || operation.status === "RUNNING"));
  const skippedCount = operation?.items.filter((item) => item.status === "SKIPPED").length ?? 0;

  const resetSelection = () => {
    setPlanImport(null);
    setSelectedRows([]);
    setPreview(null);
    setOperation(null);
    setOperationId("");
    setError("");
  };

  const setWorkbook = (workbook: PlanImport) => {
    const rows = workbook.rows.filter((row) => row.status === "READY" && row.siteId && row.engineerName);
    setPlanImport(workbook);
    setSelectedRows(rows.slice(0, 50).map((row) => row.rowNumber));
    setPreview(null);
    setOperation(null);
    setOperationId("");
    setError("");
  };

  const uploadWorkbook = async (file: File) => {
    setBusy(true);
    setError("");
    resetSelection();
    try {
      const body = new FormData();
      body.append("file", file);
      const response = await fetch("/api/imports/preview", { method: "POST", body });
      const data = await response.json() as {
        importId?: string;
        fileName?: string;
        sheetName?: string;
        rowCount?: number;
        rows?: ImportRow[];
        error?: string;
      };
      if (!response.ok) throw new Error(data.error ?? "Не удалось прочитать XLSX.");
      if (!data.importId || !data.fileName || !data.rows) throw new Error("Сервер вернул неполные данные XLSX.");
      setWorkbook({
        id: data.importId,
        fileName: data.fileName,
        sheetName: data.sheetName ?? null,
        rowCount: data.rowCount ?? data.rows.length,
        rows: data.rows
      });
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
    resetSelection();
    try {
      const response = await fetch(`/api/imports/${encodeURIComponent(batch.id)}`);
      const data = await response.json() as {
        id?: string;
        fileName?: string;
        sheetName?: string | null;
        rowCount?: number;
        rows?: ImportRow[];
        error?: string;
      };
      if (!response.ok) throw new Error(data.error ?? "Не удалось загрузить выбранный XLSX.");
      if (!data.id || !data.fileName || !data.rows) throw new Error("Сервер вернул неполные данные XLSX.");
      setWorkbook({
        id: data.id,
        fileName: data.fileName,
        sheetName: data.sheetName ?? null,
        rowCount: data.rowCount ?? data.rows.length,
        rows: data.rows
      });
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusy(false);
    }
  };

  const toggleRow = (row: ImportRow) => {
    if (row.status !== "READY" || !row.siteId || !row.engineerName) return;
    setSelectedRows((current) => {
      if (current.includes(row.rowNumber)) return current.filter((rowNumber) => rowNumber !== row.rowNumber);
      if (current.length >= 50) {
        setError("За одну операцию можно выбрать не более 50 строк XLSX.");
        return current;
      }
      setError("");
      return [...current, row.rowNumber];
    });
    setPreview(null);
  };

  const requestPreview = async () => {
    if (!planImport || selectedReadyRows.length === 0) return;
    setBusy(true);
    setError("");
    setPreview(null);
    try {
      const response = await fetch(`/api/imports/${encodeURIComponent(planImport.id)}/removal-preview`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rowNumbers: selectedReadyRows.map((row) => row.rowNumber) })
      });
      const data = await response.json() as RemovalPreview & { error?: string };
      if (!response.ok) throw new Error(data.error ?? "Не удалось проверить назначения.");
      setPreview(data);
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusy(false);
    }
  };

  const confirmRemoval = async () => {
    if (!planImport || !preview || preview.willRemove === 0) return;
    setBusy(true);
    setError("");
    try {
      const response = await fetch(`/api/imports/${encodeURIComponent(planImport.id)}/remove`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rowNumbers: selectedReadyRows.map((row) => row.rowNumber) })
      });
      const data = await response.json() as { operationId?: string; error?: string };
      if (!response.ok) throw new Error(data.error ?? "Не удалось запустить снятие инженеров.");
      if (!data.operationId) throw new Error("Сервер не вернул номер операции.");
      setOperationId(data.operationId);
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusy(false);
    }
  };

  const terminal = Boolean(operation && ["SUCCEEDED", "PARTIAL", "FAILED"].includes(operation.status));

  return (
    <section className="section-view assignment-page removal-page">
      <div className="eyebrow"><span className="eyebrow-line" /> СНЯТИЕ НАЗНАЧЕНИЙ ПО XLSX</div>
      <div className="sites-page-heading">
        <div><h1>Снять инженеров</h1><p>Будут сняты только инженеры из выбранных строк XLSX и только с указанных в них площадок.</p></div>
        {planImport && <span className="sites-total">{selectedReadyRows.length} строк выбрано · максимум 50</span>}
      </div>

      {error && <div className="assignment-error"><AlertCircle size={15} />{error}</div>}

      {!planImport ? (
        <>
          <div className="removal-source-switch" role="tablist" aria-label="Источник XLSX">
            <button className={source === "upload" ? "removal-source-active" : ""} role="tab" aria-selected={source === "upload"} onClick={() => { setSource("upload"); resetSelection(); }}>
              <Upload size={15} /> Загрузить XLSX
            </button>
            <button className={source === "history" ? "removal-source-active" : ""} role="tab" aria-selected={source === "history"} onClick={() => { setSource("history"); resetSelection(); }}>
              <Clock3 size={15} /> Выбрать из аудита
            </button>
          </div>
          {source === "upload" ? (
            <div className="panel xlsx-upload-panel removal-upload-panel">
              <div className="xlsx-upload-icon"><FileSpreadsheet size={23} /></div>
              <h2>Загрузите XLSX-план</h2>
              <p>Сверим площадки и инженеров, а затем покажем, какие назначения будут сняты.</p>
              <label className={`xlsx-dropzone ${busy ? "xlsx-dropzone-busy" : ""}`}>
                <Upload size={20} />
                <strong>{busy ? "Проверяем XLSX…" : "Выберите файл .xlsx"}</strong>
                <span>{busy ? "Пожалуйста, подождите" : "Только строки этого файла попадут в операцию"}</span>
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
                <div><h2>Файлы из аудита</h2><p>Выберите один из последних сохранённых XLSX-файлов.</p></div>
                <button className="text-button" disabled={loadingBatches} onClick={() => void loadBatches()}><RefreshCw size={13} /> Обновить</button>
              </div>
              {batchError ? <div className="import-audit-message import-audit-message-error"><AlertCircle size={15} />{batchError}</div>
                : loadingBatches ? <div className="import-audit-message">Загружаем историю XLSX…</div>
                  : batches.length === 0 ? <div className="import-audit-empty"><FileSpreadsheet size={22} /><strong>Загрузок пока нет</strong><span>Сначала загрузите файл XLSX в аудите или здесь.</span></div>
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
        <>
          <div className="panel import-summary-panel">
            <div className="import-file-heading">
              <span className="xlsx-file-icon"><FileSpreadsheet size={19} /></span>
              <div><strong>{planImport.fileName}</strong><small>{planImport.sheetName ? `Лист «${planImport.sheetName}» · ` : ""}строк в плане: {planImport.rowCount}</small></div>
              <button className="text-button" disabled={operationPending || busy} onClick={resetSelection}>Выбрать другой XLSX</button>
            </div>
            <div className="import-counts">
              <span className="import-count-ready"><CheckCircle2 size={15} /> Найдены площадка и инженер <strong>{readyRows.length}</strong></span>
              {planImport.rows.length > readyRows.length && <span className="import-count-error"><AlertCircle size={15} /> Строки с ошибками исключены <strong>{planImport.rows.length - readyRows.length}</strong></span>}
            </div>
            <p className="removal-scope-note">Никакие другие площадки и сотрудники не затрагиваются. Даже при повторном запуске сервер повторно проверит текущее назначение перед изменением.</p>
          </div>

          <div className="panel imported-rows-panel removal-rows-panel">
            <div className="imported-rows-toolbar">
              <div><h2>1. Выберите строки XLSX</h2><p>Будут обработаны только строки с найденной площадкой и инженером · до 50 строк за операцию.</p></div>
              <button className="text-button" disabled={selectedRows.length === readyRows.length || readyRows.length === 0} onClick={() => { setSelectedRows(readyRows.slice(0, 50).map((row) => row.rowNumber)); setPreview(null); }}>Выбрать первые 50</button>
            </div>
            <div className="import-row-header removal-row-header"><span>Строка / площадка</span><span>Адрес</span><span>Инженер из XLSX</span><span>Проверка</span></div>
            <div className="import-row-list">
              {planImport.rows.map((row) => {
                const ready = row.status === "READY" && Boolean(row.siteId && row.engineerName);
                return (
                  <label className={`import-plan-row ${ready ? "import-plan-row-ready" : "import-plan-row-invalid"}`} key={row.rowNumber}>
                    <span className="import-row-id">
                      <input type="checkbox" checked={selectedRows.includes(row.rowNumber)} disabled={!ready || busy || operationPending} onChange={() => toggleRow(row)} />
                      <span>Строка {row.rowNumber}<small>{row.siteId ?? "ID не указан"}</small></span>
                    </span>
                    <span className="import-address" title={row.address ?? ""}>{row.address ?? "Адрес не указан"}</span>
                    <span className="import-engineer" title={row.engineerName ?? ""}>{row.engineerName ?? "Инженер не указан"}</span>
                    <span className={`import-row-badge ${ready ? "import-row-badge-ready" : "import-row-badge-error"}`}>{ready ? "Готова к проверке" : "Исключена: нет совпадения"}</span>
                  </label>
                );
              })}
            </div>
          </div>

          <div className="import-preview-action">
            <button className="btn-primary" disabled={busy || selectedReadyRows.length === 0 || operationPending} onClick={() => void requestPreview()}>
              <ShieldCheck size={16} /> {busy ? "Проверяем…" : "Проверить снятие по XLSX"}
            </button>
          </div>

          {preview && (
            <div className="panel xlsx-assignment-preview removal-preview">
              <div className="assignment-panel-heading">
                <div><h2>2. Предпросмотр снятия</h2><p>К снятию отмечено назначений: {preview.willRemove} из {preview.count} выбранных строк файла «{preview.fileName}».</p></div>
                <span className="preview-valid-label"><CheckCircle2 size={14} /> Проверено</span>
              </div>
              <div className="preview-summary">С сервера YouGile повторно прочитано текущее состояние. Список оставшихся инженеров сохраняется; если сотрудник уже снят, строка не изменит задачу.</div>
              <div className="xlsx-preview-list">
                {preview.items.map((item) => (
                  <div className={`xlsx-preview-row removal-preview-row ${item.willRemove ? "" : "removal-preview-row-skip"}`} key={item.rowNumber}>
                    <span className="site-number">{item.siteId}</span>
                    <span className="xlsx-preview-address" title={item.address ?? ""}>{item.address ?? "Адрес не указан"}<small>Строка {item.rowNumber}</small></span>
                    <span className="xlsx-preview-engineer">{item.engineerName}<small>{item.willRemove ? "Будет снят" : "Не назначен — без изменений"}</small></span>
                    <span className="xlsx-preview-current">
                      <span>Сейчас: {item.assignedEngineerNames.join(", ") || "нет ответственных"}</span>
                      <small>Останутся: {item.remainingEngineerNames.join(", ") || "нет ответственных"}</small>
                    </span>
                  </div>
                ))}
              </div>
              <button className="btn-primary assignment-confirm-button" disabled={busy || operationPending || preview.willRemove === 0} onClick={() => void confirmRemoval()}>
                <CheckCircle2 size={16} /> {busy ? "Запускаем…" : "Подтвердить снятие выбранных инженеров"}
              </button>
              {preview.willRemove === 0 && <p className="removal-noop-note">В выбранных строках нет текущих назначений, которые можно снять.</p>}
            </div>
          )}
        </>
      )}

      {operationId && (
        <div className={`panel assignment-operation ${terminal ? "assignment-operation-done" : ""}`}>
          <div className="assignment-panel-heading">
            <div><h2>{operation?.status === "SUCCEEDED" ? "Снятие инженеров завершено" : operation?.status === "PARTIAL" || operation?.status === "FAILED" ? "Результат снятия инженеров" : "Снимаем инженеров по XLSX"}</h2><p>{operation?.message ?? "Операция добавлена в очередь."}</p></div>
            {operation && <span className="sites-total">{operation.completed} / {operation.total}</span>}
          </div>
          {operationPending && <div className="operation-progress"><span style={{ width: `${operation ? Math.round(operation.completed / operation.total * 100) : 2}%` }} /></div>}
          {operation && skippedCount > 0 && <p className="removal-result-note">{skippedCount} строк без изменений: инженер уже не был назначен.</p>}
          {operation && operation.failed > 0 && <div className="operation-failures">{operation.items.filter((item) => item.status === "FAILED").map((item) => <p key={item.siteId}>Площадка {item.siteId}: {item.errorMessage}</p>)}</div>}
        </div>
      )}
      <footer className="page-footer"><span>YouGile Operations Portal <span className="footer-version">v0.1</span></span><span>Источник снятия — выбранный XLSX из загрузки или аудита</span></footer>
    </section>
  );
}
