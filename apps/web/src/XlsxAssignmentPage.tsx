import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDownToLine,
  AlertTriangle,
  CheckCircle2,
  FileSpreadsheet,
  Search,
  ShieldCheck,
  Upload
} from "lucide-react";
import BulkWarningDialog, { largeSelectionThreshold } from "./BulkWarningDialog";
import OperationSites from "./OperationSites";
import ErrorDiagnostics from "./ErrorDiagnostics";
import { operationDiagnosticsPayload, type ErrorDetail } from "./diagnostics";
import { useStepScroll } from "./useStepScroll";
import { apiFetch } from "./apiClient";
import { findActiveOperation } from "./activeOperations";
import { countRu, rowForms, siteForms } from "./plural";
import { PORTAL_VERSION } from "./version";

type ImportRow = {
  rowNumber: number;
  siteId: string | null;
  address: string | null;
  engineerName: string | null;
  engineerUserId: string | null;
  yougileTaskId: string | null;
  status: "READY" | "SITE_NOT_FOUND" | "ENGINEER_NOT_FOUND" | "INVALID_ROW" | "DUPLICATE_SITE";
};
type CommentTemplateOption = {
  type: string;
  label: string;
  workType: string;
  isCustom: boolean;
  value: string;
};
type PlanImport = {
  importId: string;
  fileName: string;
  sheetName: string;
  rowCount: number;
  counts: { ready: number; siteNotFound: number; engineerNotFound: number; invalid: number; duplicate: number };
  rows: ImportRow[];
};
type AssignmentPreview = {
  importId: string;
  count: number;
  alreadyAssigned: number;
  items: {
    rowNumber: number;
    siteId: string;
    address: string | null;
    engineerName: string;
    taskId: string;
    userId: string;
    currentUserIds: string[];
    alreadyAssigned: boolean;
    comment: string;
    currentEngineers: { id: string; name: string }[];
  }[];
};
type Operation = {
  id: string;
  status: "QUEUED" | "RUNNING" | "SUCCEEDED" | "PARTIAL" | "FAILED" | "CANCELLED";
  total: number;
  completed: number;
  failed: number;
  message: string | null;
  items: { siteId: string; status: string; errorMessage: string | null; label: string | null; details?: ErrorDetail | null }[];
  errorDetails?: ErrorDetail | null;
};

const pageSize = 15;

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Не удалось выполнить операцию.";
}

function importRowProblem(row: ImportRow) {
  const problems: string[] = [];
  if (!row.siteId) problems.push("Не указан номер площадки.");
  else if (!row.yougileTaskId) problems.push("Площадка не найдена в активном плане YouGile.");
  if (row.status === "DUPLICATE_SITE") problems.push("Площадка указана в XLSX больше одного раза.");
  if (!row.engineerName) problems.push("Не указано имя инженера.");
  else if (!row.engineerUserId) problems.push(`Инженер «${row.engineerName}» не найден в YouGile.`);
  return problems.join(" ");
}

export default function XlsxAssignmentPage({ onComplete }: { onComplete: () => void }) {
  const [planImport, setPlanImport] = useState<PlanImport | null>(null);
  const [selectedRows, setSelectedRows] = useState<number[]>([]);
  const [preview, setPreview] = useState<AssignmentPreview | null>(null);
  const [comment, setComment] = useState("");
  const [commentTemplates, setCommentTemplates] = useState<CommentTemplateOption[]>([]);
  const [selectedCommentTemplate, setSelectedCommentTemplate] = useState("");
  const selectedTemplate = commentTemplates.find((template) => template.type === selectedCommentTemplate);
  const [templatesLoading, setTemplatesLoading] = useState(true);
  const [templatesError, setTemplatesError] = useState("");
  const [operation, setOperation] = useState<Operation | null>(null);
  const [operationId, setOperationId] = useState("");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [busy, setBusy] = useState(false);
  const [downloadingProblems, setDownloadingProblems] = useState(false);
  const [error, setError] = useState("");
  const [bulkWarning, setBulkWarning] = useState<PlanImport | null>(null);
  const rowsStepRef = useRef<HTMLDivElement>(null);
  const previewStepRef = useRef<HTMLDivElement>(null);
  const operationStepRef = useRef<HTMLDivElement>(null);
  const stepKey = operationId ? "operation" : preview ? "preview" : planImport ? "rows" : null;
  const stepRef = stepKey === "operation" ? operationStepRef : stepKey === "preview" ? previewStepRef : rowsStepRef;
  useStepScroll(stepKey, stepRef);

  useEffect(() => {
    const controller = new AbortController();
    const loadTemplates = async () => {
      try {
        const response = await apiFetch("/api/settings/comment-templates", { signal: controller.signal });
        const data = await response.json() as { templates?: CommentTemplateOption[]; error?: string };
        if (!response.ok) throw new Error(data.error ?? "Не удалось загрузить шаблоны комментариев.");
        if (!data.templates) throw new Error("Сервер не вернул шаблоны комментариев.");
        setCommentTemplates(data.templates);
        setTemplatesError("");
      } catch (reason) {
        if (!controller.signal.aborted) setTemplatesError(errorMessage(reason));
      } finally {
        if (!controller.signal.aborted) setTemplatesLoading(false);
      }
    };
    void loadTemplates();
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (!operationId) return;
    let active = true;
    let timeout: ReturnType<typeof setTimeout>;

    const poll = async () => {
      try {
        const response = await apiFetch(`/api/operations/${encodeURIComponent(operationId)}`);
        const data = await response.json() as Operation & { error?: string };
        if (!response.ok) throw new Error(data.error ?? "Не удалось получить ход операции.");
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

  // Восстановление панели хода: если операция запущена и выполняется в фоне,
  // а пользователь вернулся на страницу сценария (в том числе после
  // перезагрузки), подхватываем активную операцию этого типа и продолжаем
  // показывать её ход, как будто страницу не закрывали.
  useEffect(() => {
    if (operationId) return;
    const controller = new AbortController();
    void findActiveOperation("ASSIGN", controller.signal)
      .then((operation) => {
        if (operation && !controller.signal.aborted) setOperationId(operation.id);
      })
      .catch(() => {});
    return () => controller.abort();
  }, [operationId]);

  const filteredRows = useMemo(() => {
    const rows = planImport?.rows ?? [];
    const normalizedQuery = query.trim().toLocaleLowerCase("ru");
    return normalizedQuery
      ? rows.filter((row) => `${row.siteId ?? ""} ${row.address ?? ""} ${row.engineerName ?? ""}`.toLocaleLowerCase("ru").includes(normalizedQuery))
      : rows;
  }, [planImport, query]);
  const pageCount = Math.max(1, Math.ceil(filteredRows.length / pageSize));
  const currentPage = Math.min(page, pageCount);
  const visibleRows = filteredRows.slice((currentPage - 1) * pageSize, currentPage * pageSize);
  const selectedReadyRows = (planImport?.rows ?? []).filter((row) => selectedRows.includes(row.rowNumber) && row.status === "READY");
  const validComment = comment.trim().length > 0 && comment.length <= 10_000;
  const operationPending = Boolean(operationId && (!operation || operation.status === "QUEUED" || operation.status === "RUNNING"));
  // Адреса площадок для таблицы состояний. Из предпросмотра — для своей
  // операции; при восстановлении после ухода со страницы предпросмотра уже нет,
  // тогда адрес берём из ответа операции (label из beforeData на сервере).
  const siteLabels = useMemo(() => {
    const map: Record<string, string | null> = {};
    if (preview) {
      for (const item of preview.items) map[item.siteId] = item.address;
    } else if (operation) {
      for (const item of operation.items) map[item.siteId] = item.label;
    }
    return Object.keys(map).length > 0 ? map : undefined;
  }, [preview, operation]);

  const uploadWorkbook = async (file: File) => {
    setBusy(true);
    setError("");
    setPlanImport(null);
    setPreview(null);
    setSelectedRows([]);
    setOperation(null);
    setOperationId("");
    setComment("");
    try {
      const body = new FormData();
      body.append("file", file);
      const response = await apiFetch("/api/imports/preview", { method: "POST", body });
      const data = await response.json() as PlanImport & { error?: string };
      if (!response.ok) throw new Error(data.error ?? "Не удалось прочитать XLSX.");
      // Лимита площадок нет, поэтому большой план предупреждаем, а не обрезаем.
      if (data.counts.ready > largeSelectionThreshold) {
        setBulkWarning(data);
        return;
      }
      applyWorkbook(data);
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusy(false);
    }
  };

  const applyWorkbook = (data: PlanImport) => {
    setPlanImport(data);
    setSelectedRows(data.rows.filter((row) => row.status === "READY").map((row) => row.rowNumber));
    setPage(1);
    setQuery("");
  };

  const toggleRow = (row: ImportRow) => {
    if (row.status !== "READY") return;
    setSelectedRows((current) => current.includes(row.rowNumber)
      ? current.filter((rowNumber) => rowNumber !== row.rowNumber)
      : [...current, row.rowNumber]);
    setPreview(null);
  };

  const requestAssignmentPreview = async () => {
    if (!planImport || selectedReadyRows.length === 0 || !selectedCommentTemplate || !validComment) return;
    setBusy(true);
    setError("");
    setPreview(null);
    try {
      const response = await apiFetch(`/api/imports/${encodeURIComponent(planImport.importId)}/assignment-preview`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          rowNumbers: selectedReadyRows.map((row) => row.rowNumber),
          workType: selectedTemplate?.workType,
          commentTemplate: comment.trim()
        })
      });
      const data = await response.json() as AssignmentPreview & { error?: string };
      if (!response.ok) throw new Error(data.error ?? "Не удалось проверить выбранные строки.");
      setPreview(data);
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusy(false);
    }
  };

  const confirmAssignment = async () => {
    if (!planImport || !preview || !selectedCommentTemplate || !validComment) return;
    setBusy(true);
    setError("");
    try {
      const response = await apiFetch(`/api/imports/${encodeURIComponent(planImport.importId)}/assign`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          rowNumbers: selectedReadyRows.map((row) => row.rowNumber),
          workType: selectedTemplate?.workType,
          commentTemplate: comment.trim()
        })
      });
      const data = await response.json() as { operationId?: string; error?: string };
      if (!response.ok) throw new Error(data.error ?? "Не удалось запустить назначение.");
      if (!data.operationId) throw new Error("Сервер не вернул номер операции.");
      setOperationId(data.operationId);
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusy(false);
    }
  };

  const downloadProblematicSites = async () => {
    if (!planImport || problematicRows.length === 0 || downloadingProblems) return;
    setDownloadingProblems(true);
    setError("");
    try {
      const response = await apiFetch(`/api/imports/${encodeURIComponent(planImport.importId)}/problematic-sites.xlsx`);
      if (!response.ok) {
        const data = await response.json() as { error?: string };
        throw new Error(data.error ?? "Не удалось скачать список проблемных площадок.");
      }
      const file = await response.blob();
      const url = URL.createObjectURL(file);
      const link = document.createElement("a");
      link.href = url;
      link.download = "problematic-sites.xlsx";
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setDownloadingProblems(false);
    }
  };

  const clearImport = () => {
    setPlanImport(null);
    setPreview(null);
    setSelectedRows([]);
    setOperation(null);
    setOperationId("");
    setComment("");
    setError("");
    setBulkWarning(null);
  };
  const problematicRows = [
    ...(planImport?.rows.filter((row) => row.status !== "READY").map((row) => ({
      rowNumber: row.rowNumber,
      siteId: row.siteId,
      address: row.address,
      engineerName: row.engineerName,
      problem: importRowProblem(row)
    })) ?? []),
    ...(operation?.items.filter((item) => item.status === "FAILED").map((item) => {
      const sourceRow = planImport?.rows.find((row) => row.siteId === item.siteId);
      return {
        rowNumber: sourceRow?.rowNumber ?? null,
        siteId: item.siteId,
        address: sourceRow?.address ?? null,
        engineerName: sourceRow?.engineerName ?? null,
        problem: item.errorMessage ?? "Не удалось выполнить назначение."
      };
    }) ?? [])
  ];

  return (
    <section className="section-view assignment-page">
      <div className="eyebrow"><span className="eyebrow-line" /> АВТОМАТИЧЕСКАЯ ПРОВЕРКА ПЛОЩАДОК И СОТРУДНИКОВ</div>
      <div className="sites-page-heading">
        <div><h1>Назначить инженеров по XLSX</h1><p>Площадки и сотрудники сверяются с YouGile автоматически; для найденных строк можно добавить комментарий.</p></div>
        {planImport && <span className="sites-total">{selectedReadyRows.length} из {planImport.counts.ready} совпавших строк</span>}
      </div>

      {error && <div className="assignment-error">{error}</div>}

      {!planImport && !operationId ? (
        <div className="panel xlsx-upload-panel">
          <div className="xlsx-upload-icon"><FileSpreadsheet size={23} /></div>
          <h2>Загрузите XLSX-план</h2>
          <p>Автоматически проверим площадки и имена инженеров по актуальным данным YouGile.</p>
          <label className={`xlsx-dropzone ${busy ? "xlsx-dropzone-busy" : ""}`}>
            <Upload size={20} />
            <strong>{busy ? "Проверяем площадки и инженеров…" : "Выберите файл .xlsx"}</strong>
            <span>{busy ? "Пожалуйста, подождите" : "Файл обрабатывается локальным API сервера"}</span>
            <input type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" disabled={busy} onChange={(event) => {
              const file = event.currentTarget.files?.[0];
              event.currentTarget.value = "";
              if (file) void uploadWorkbook(file);
            }} />
          </label>
        </div>
      ) : planImport ? (
        <>
          <div className="panel import-summary-panel">
            <div className="import-file-heading">
              <span className="xlsx-file-icon"><FileSpreadsheet size={19} /></span>
              <div><strong>{planImport.fileName}</strong><small>Лист «{planImport.sheetName}» · {countRu(planImport.rowCount, rowForms)} в плане</small></div>
              <button className="text-button" disabled={operationPending} onClick={clearImport}>Загрузить другой XLSX</button>
            </div>
            <div className="import-counts">
              <span className="import-count-ready"><CheckCircle2 size={15} /> Совпали с YouGile <strong>{planImport.counts.ready}</strong></span>
              <span className="import-count-error"><AlertTriangle size={15} /> Площадка не найдена <strong>{planImport.counts.siteNotFound}</strong></span>
              {planImport.counts.engineerNotFound > 0 && <span className="import-count-error"><AlertTriangle size={15} /> Инженер не найден <strong>{planImport.counts.engineerNotFound}</strong></span>}
              {planImport.counts.duplicate > 0 && <span className="import-count-error"><AlertTriangle size={15} /> Дубликаты <strong>{planImport.counts.duplicate}</strong></span>}
              {planImport.counts.invalid > 0 && <span className="import-count-error"><AlertTriangle size={15} /> Некорректные строки <strong>{planImport.counts.invalid}</strong></span>}
            </div>
            {(planImport.counts.siteNotFound > 0 || planImport.counts.engineerNotFound > 0) && <p className="import-scope-note">В обработку попадут только строки, где и площадка, и инженер найдены в YouGile. Остальные строки показаны в списке проблем.</p>}
          </div>

          <div className="panel imported-rows-panel" ref={rowsStepRef}>
            <div className="imported-rows-toolbar">
              <div><h2>1. Площадки из загруженного плана</h2><p>{countRu(selectedReadyRows.length, rowForms)} с найденной площадкой и инженером выбрано · строки с ошибками нельзя назначить</p></div>
              <label className="sites-search"><Search size={15} /><input value={query} onChange={(event) => { setQuery(event.target.value); setPage(1); }} placeholder="Номер, адрес или инженер" /></label>
            </div>
            <div className="import-row-header"><span>Строка / ID</span><span>Адрес площадки</span><span>Инженер из XLSX</span><span>Статус</span></div>
            <div className="import-row-list">
              {visibleRows.map((row) => (
                <label className={`import-plan-row ${row.status === "READY" ? "import-plan-row-ready" : "import-plan-row-invalid"}`} key={row.rowNumber}>
                  <span className="import-row-id">
                    <input type="checkbox" disabled={row.status !== "READY" || operationPending} checked={selectedRows.includes(row.rowNumber)} onChange={() => toggleRow(row)} />
                    <span>Стр. {row.rowNumber}<small>{row.siteId ?? "—"}</small></span>
                  </span>
                  <span className="import-address" title={row.address ?? ""}>{row.address ?? "Адрес не указан"}</span>
                  <span className="import-engineer" title={row.engineerName ?? ""}>{row.engineerName ?? "Инженер не указан"}</span>
                  <span><ImportRowBadge status={row.status} /></span>
                </label>
              ))}
            </div>
            <div className="sites-pagination">
              <span>Показано {filteredRows.length ? (currentPage - 1) * pageSize + 1 : 0}–{Math.min(currentPage * pageSize, filteredRows.length)} из {filteredRows.length}</span>
              <div><button disabled={currentPage <= 1} onClick={() => setPage(currentPage - 1)}>Назад</button><span>{currentPage} / {pageCount}</span><button disabled={currentPage >= pageCount} onClick={() => setPage(currentPage + 1)}>Вперёд</button></div>
            </div>
          </div>

          <div className="panel import-comment-panel">
            <div className="assignment-panel-heading"><div><h2>2. Шаблон комментария</h2><p>Для каждой выбранной строки шаблон будет сформирован по значениям XLSX.</p></div></div>
            <div className="saved-template-picker">
              <label className="field-label" htmlFor="saved-comment-template">
                <span>Категория работ / шаблон</span>
                <select
                  id="saved-comment-template"
                  value={selectedCommentTemplate}
                  disabled={templatesLoading || operationPending}
                  onChange={(event) => setSelectedCommentTemplate(event.target.value)}
                >
                  <option value="">{templatesLoading ? "Загружаем шаблоны…" : "Выберите категорию и шаблон"}</option>
                  {commentTemplates.map((template) => (
                    <option key={template.type} value={template.type}>
                      {template.label}{template.isCustom ? " · Другое" : ""}{template.value.trim() ? "" : " · пустой"}
                    </option>
                  ))}
                </select>
              </label>
              <button
                className="text-button"
                disabled={!selectedCommentTemplate || templatesLoading || operationPending || !selectedTemplate?.value.trim()}
                onClick={() => {
                  if (!selectedTemplate) return;
                  setComment(selectedTemplate.value);
                  setPreview(null);
                }}
              >
                Вставить шаблон
              </button>
            </div>
            {templatesError && <p className="saved-template-error">{templatesError} Можно ввести текст вручную.</p>}
            <label className="field-label import-comment-field">
              <span>Текст шаблона</span>
              <textarea
                value={comment}
                maxLength={10_000}
                rows={4}
                disabled={operationPending}
                onChange={(event) => {
                  setComment(event.target.value);
                  setPreview(null);
                }}
                placeholder="Например: Работы запланированы на ${data}, время ${time}"
              />
            </label>
            <p className="comment-template-hint">Выберите один из четырёх видов работ для статистики. Этот тип сохраняется вместе с операцией; сам текст комментария можно отредактировать вручную. <code>{"${data}"}</code> и <code>{"${time}"}</code> подставляются из XLSX.</p>
            <span className="comment-character-count">{comment.length.toLocaleString("ru-RU")} / 10 000</span>
          </div>

          {problematicRows.length > 0 && (
            <div className="panel problematic-sites-panel">
              <div className="assignment-panel-heading">
                <div><h2>Проблемные площадки</h2><p>Эти строки не назначены или требуют проверки. Строки с ошибками XLSX исключены из запуска.</p></div>
                <div className="problem-sites-actions">
                  <span className="problem-sites-count">{problematicRows.length}</span>
                  <button className="text-button problem-sites-download" disabled={downloadingProblems} onClick={() => void downloadProblematicSites()}>
                    <ArrowDownToLine size={14} /> {downloadingProblems ? "Формируем XLSX…" : "Скачать XLSX"}
                  </button>
                </div>
              </div>
              <div className="problem-sites-list">
                {problematicRows.map((row, index) => (
                  <div className="problem-site-row" key={`${row.rowNumber ?? "operation"}-${row.siteId ?? "unknown"}-${index}`}>
                    <span className="site-number">{row.siteId ?? "—"}</span>
                    <span className="problem-site-details">
                      {row.address ?? "Адрес не указан"}
                      <small>{row.rowNumber ? `Строка ${row.rowNumber}` : "Результат операции"}{row.engineerName ? ` · ${row.engineerName}` : ""}</small>
                    </span>
                    <span className="problem-site-reason">{row.problem}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="import-preview-action">
            <button className="btn-primary" disabled={busy || selectedReadyRows.length === 0 || !selectedCommentTemplate || !validComment || operationPending} onClick={() => void requestAssignmentPreview()}>
              <ShieldCheck size={16} /> {busy ? "Проверяем…" : "Проверить назначения и комментарий"}
            </button>
            {selectedReadyRows.length > 0 && !selectedCommentTemplate && <span>Выберите вид работ, чтобы назначение попало в статистику по категориям.</span>}
            {selectedReadyRows.length > 0 && selectedCommentTemplate && !validComment && <span>Введите шаблон комментария для выбранных задач.</span>}
          </div>

          {preview && (
            <div className="panel xlsx-assignment-preview" ref={previewStepRef}>
              <div className="assignment-panel-heading"><div><h2>3. Предпросмотр изменений</h2><p>{countRu(preview.count, siteForms)}, только из загруженного XLSX</p></div><span className="preview-valid-label"><CheckCircle2 size={14} /> Проверено</span></div>
              <div className="preview-summary">Для каждой строки будет назначен инженер из XLSX, а сформированный по её дате и времени комментарий отправлен в чат задачи. Существующие ответственные сохраняются; комментарий отправится и если инженер уже назначен.</div>
              <blockquote className="comment-preview"><strong>Шаблон:</strong> {comment.trim()}</blockquote>
              <div className="xlsx-preview-list">
                {preview.items.map((item) => (
                  <div className="xlsx-preview-row" key={item.rowNumber}>
                    <span className="site-number">{item.siteId}</span>
                    <span className="xlsx-preview-address" title={item.address ?? ""}>{item.address ?? "Адрес не указан"}<small>Строка {item.rowNumber}</small></span>
                    <span className="xlsx-preview-engineer">{item.engineerName}<small>{item.alreadyAssigned ? "Уже назначен" : "Будет добавлен"}</small></span>
                    <span className="xlsx-preview-current" title={item.currentEngineers.map((user) => user.name).join(", ")}>
                      <span>Сейчас: {item.currentEngineers.map((user) => user.name).join(", ") || "нет ответственных"}</span>
                      <small className="xlsx-preview-comment">{item.comment}</small>
                    </span>
                  </div>
                ))}
              </div>
              <button className="btn-primary assignment-confirm-button" disabled={!selectedCommentTemplate || !validComment || busy || operationPending} onClick={() => void confirmAssignment()}>
                <CheckCircle2 size={16} /> Подтвердить назначения и комментарии
              </button>
            </div>
          )}
        </>
      ) : null}

      {operationId && (
        <div className={`panel assignment-operation ${operation && ["SUCCEEDED", "PARTIAL", "FAILED"].includes(operation.status) ? "assignment-operation-done" : ""}`} ref={operationStepRef}>
          <div className="assignment-panel-heading">
            <div><h2>{operation?.status === "SUCCEEDED" ? "Назначения и комментарии по XLSX завершены" : operation?.status === "PARTIAL" || operation?.status === "FAILED" ? "Результат назначения и комментариев" : "Назначаем инженеров и отправляем комментарии"}</h2><p>{operation?.message ?? "Операция добавлена в очередь."}</p></div>
            {operation && <span className="sites-total">{operation.completed} / {operation.total}</span>}
          </div>
          {operationPending && <div className="operation-progress"><span style={{ transform: `scaleX(${operation && operation.total > 0 ? operation.completed / operation.total : 0.02})` }} /></div>}
          {operation && operation.items.length > 0 && <OperationSites items={operation.items} labelColumn="Адрес" labels={siteLabels} />}
          {operation && operation.failed > 0 && <div className="operation-failures">{operation.items.filter((item) => item.status === "FAILED").map((item) => <p key={item.siteId}>Площадка {item.siteId}: {item.errorMessage}</p>)}</div>}
          {(Boolean(error) || Boolean(operation && (operation.failed > 0 || operation.errorDetails || ["FAILED", "PARTIAL"].includes(operation.status)))) && (
            <ErrorDiagnostics payload={operationDiagnosticsPayload({ action: "Назначение инженеров и комментариев по XLSX", operation, apiError: error || null })} />
          )}
        </div>
      )}
      <footer className="page-footer"><span>YouGile Operations Portal <span className="footer-version">{PORTAL_VERSION}</span></span><span>Источник назначений — выбранные строки XLSX</span></footer>

      {bulkWarning && (
        <BulkWarningDialog
          fileName={bulkWarning.fileName}
          siteCount={bulkWarning.counts.ready}
          skippedCount={bulkWarning.rowCount - bulkWarning.counts.ready}
          onConfirm={() => { applyWorkbook(bulkWarning); setBulkWarning(null); }}
          onCancel={() => setBulkWarning(null)}
        />
      )}
    </section>
  );
}

function ImportRowBadge({ status }: { status: ImportRow["status"] }) {
  const label = {
    READY: "Совпала",
    SITE_NOT_FOUND: "Нет в YouGile",
    ENGINEER_NOT_FOUND: "Инженер не найден",
    INVALID_ROW: "Проверьте строку",
    DUPLICATE_SITE: "Дубликат площадки"
  }[status];
  return <span className={`import-row-badge ${status === "READY" ? "import-row-badge-ready" : "import-row-badge-error"}`}>{label}</span>;
}
