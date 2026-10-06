import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  CheckCircle2,
  MessageSquarePlus,
  RefreshCw,
  Search,
  ShieldCheck
} from "lucide-react";
import { useStepScroll } from "./useStepScroll";
import { apiFetch } from "./apiClient";
import { findActiveOperation } from "./activeOperations";
import OperationSites from "./OperationSites";
import { countRu, siteForms } from "./plural";
import { PORTAL_VERSION } from "./version";

export type PlannedSite = {
  taskId: string;
  siteNumber: string;
  title: string;
  assignedCount: number;
  completed: boolean;
  updatedAt: string | null;
};
export type SiteLoadState = "loading" | "ready" | "error";

type CommentTemplateOption = {
  type: string;
  label: string;
  value: string;
};
type CommentPreview = {
  comment: string;
  count: number;
  items: {
    taskId: string;
    siteNumber: string;
    title: string;
    currentEngineers: { id: string; name: string }[];
    lastComment: string | null;
    lastCommentAt: string | null;
    lastCommentError: string | null;
  }[];
};
type Operation = {
  id: string;
  status: "QUEUED" | "RUNNING" | "SUCCEEDED" | "PARTIAL" | "FAILED" | "CANCELLED";
  total: number;
  completed: number;
  failed: number;
  message: string | null;
  items: { siteId: string; status: string; errorMessage: string | null; label: string | null }[];
};

const pageSize = 25;
// Аварийный предохранитель, такой же, как в API: без лимита на площадки операция
// может занять очередь на долгое время.
const maxSites = 2000;

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Не удалось выполнить операцию.";
}

function formatDate(value: string | null) {
  if (!value) return "";
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? date.toLocaleString("ru-RU", { dateStyle: "short", timeStyle: "short" })
    : "";
}

export default function CommentPage({
  sites,
  loadState,
  siteError,
  onComplete,
  onOpenHistory
}: {
  sites: PlannedSite[];
  loadState: SiteLoadState;
  siteError: string;
  onComplete: () => void;
  onOpenHistory: () => void;
}) {
  const [selectedTaskIds, setSelectedTaskIds] = useState<string[]>([]);
  const [comment, setComment] = useState("");
  const [commentTemplates, setCommentTemplates] = useState<CommentTemplateOption[]>([]);
  const [selectedTemplate, setSelectedTemplate] = useState("");
  const [templatesLoading, setTemplatesLoading] = useState(true);
  const [templatesError, setTemplatesError] = useState("");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [preview, setPreview] = useState<CommentPreview | null>(null);
  const [operation, setOperation] = useState<Operation | null>(null);
  const [operationId, setOperationId] = useState("");
  const [operationError, setOperationError] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const previewStepRef = useRef<HTMLDivElement>(null);
  const operationStepRef = useRef<HTMLDivElement>(null);
  const stepKey = operationId ? "operation" : preview ? "preview" : null;
  const stepRef = stepKey === "operation" ? operationStepRef : previewStepRef;
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
        setOperationError(errorMessage(reason));
        timeout = setTimeout(poll, 2500);
      }
    };

    void poll();
    return () => {
      active = false;
      clearTimeout(timeout);
    };
  }, [operationId, onComplete]);

  // Восстановление панели хода: если отправка комментариев запущена и идёт
  // в фоне, а пользователь вернулся на страницу сценария (в том числе после
  // перезагрузки), подхватываем активную операцию этого типа и продолжаем
  // показывать её ход.
  useEffect(() => {
    if (operationId) return;
    const controller = new AbortController();
    void findActiveOperation("COMMENT", controller.signal)
      .then((operation) => {
        if (operation && !controller.signal.aborted) setOperationId(operation.id);
      })
      .catch(() => {});
    return () => controller.abort();
  }, [operationId]);

  const filteredSites = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase("ru");
    return normalizedQuery
      ? sites.filter((site) => `${site.siteNumber} ${site.title}`.toLocaleLowerCase("ru").includes(normalizedQuery))
      : sites;
  }, [sites, query]);

  const pageCount = Math.max(1, Math.ceil(filteredSites.length / pageSize));
  const currentPage = Math.min(page, pageCount);
  const visibleSites = filteredSites.slice((currentPage - 1) * pageSize, currentPage * pageSize);
  const validComment = comment.trim().length > 0 && comment.length <= 10_000;
  const operationPending = Boolean(operationId && (!operation || operation.status === "QUEUED" || operation.status === "RUNNING"));
  const limitReached = selectedTaskIds.length >= maxSites;
  const failedItems = operation?.items.filter((item) => item.status === "FAILED") ?? [];
  const siteLabels = useMemo(() => {
    const map: Record<string, string | null> = {};
    for (const site of sites) map[site.siteNumber] = site.title;
    if (preview) for (const item of preview.items) map[item.siteNumber] = item.title;
    // При восстановлении после ухода со страницы предпросмотра нет — названия
    // задач берём из ответа операции (label из beforeData на сервере).
    if (operation) for (const item of operation.items) map[item.siteId] = item.label;
    return map;
  }, [sites, preview, operation]);

  const updateSelection = (taskId: string, checked: boolean) => {
    setSelectedTaskIds((current) => {
      if (checked) return current.length >= maxSites ? current : [...current, taskId];
      return current.filter((id) => id !== taskId);
    });
    setPreview(null);
    setError("");
  };

  const selectAllVisible = () => {
    const visibleIds = visibleSites.map((site) => site.taskId);
    setSelectedTaskIds((current) => [...new Set([...current, ...visibleIds])].slice(0, maxSites));
    setPreview(null);
    setError("");
  };

  const requestPreview = async () => {
    setBusy(true);
    setError("");
    setPreview(null);
    try {
      const response = await apiFetch("/api/comments/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          taskIds: selectedTaskIds,
          comment: comment.trim(),
          ...(selectedTemplate ? { commentTemplate: selectedTemplate } : {})
        })
      });
      const data = await response.json() as CommentPreview & { error?: string };
      if (!response.ok) throw new Error(data.error ?? "Не удалось проверить площадки в YouGile.");
      setPreview(data);
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusy(false);
    }
  };

  const sendComments = async () => {
    if (!validComment || selectedTaskIds.length === 0) return;
    setBusy(true);
    setError("");
    setOperationError("");
    setOperation(null);
    try {
      const response = await apiFetch("/api/comments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          taskIds: selectedTaskIds,
          comment: comment.trim(),
          ...(selectedTemplate ? { commentTemplate: selectedTemplate } : {})
        })
      });
      const data = await response.json() as { operationId?: string; error?: string };
      if (!response.ok) throw new Error(data.error ?? "Не удалось запустить отправку комментариев.");
      if (!data.operationId) throw new Error("Сервер не вернул номер операции.");
      setOperationId(data.operationId);
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusy(false);
    }
  };

  const resetForm = () => {
    setSelectedTaskIds([]);
    setPreview(null);
    setOperation(null);
    setOperationId("");
    setOperationError("");
    setError("");
    setPage(1);
  };

  return (
    <section className="section-view assignment-page comment-page">
      <div className="eyebrow"><span className="eyebrow-line" /> КОММЕНТАРИЙ УХОДИТ В ЧАТ ЗАДАЧИ YOUGILE</div>
      <div className="sites-page-heading">
        <div>
          <h1>Написать комментарий</h1>
          <p>Выберите одну или несколько площадок и напишите комментарий — он отправится в чат задачи YouGile.</p>
        </div>
        <span className="sites-total">{selectedTaskIds.length.toLocaleString("ru-RU")} выбрано</span>
      </div>

      {error && <div className="assignment-error"><AlertCircle size={15} />{error}</div>}

      <div className="assignment-layout">
        <div className="panel assignment-sites-panel">
          <div className="assignment-panel-heading">
            <div>
              <h2>1. Выберите площадки</h2>
              <p>Список активных задач загружен из колонки плана YouGile.</p>
            </div>
            {selectedTaskIds.length > 0 && <button className="text-button" disabled={operationPending} onClick={resetForm}>Сбросить</button>}
          </div>
          <label className="sites-search assignment-search">
            <Search size={15} />
            <input value={query} onChange={(event) => { setQuery(event.target.value); setPage(1); }} placeholder="Поиск по номеру или адресу" />
          </label>

          {loadState === "loading" ? <div className="assignment-loading">Загружаем план…</div>
            : loadState === "error" ? <div className="sites-page-message sites-message-error">{siteError}</div>
              : filteredSites.length === 0 ? <div className="sites-page-message">{query ? "По вашему запросу площадок не найдено." : "В колонке плана пока нет площадок."}</div>
                : (
                  <>
                    <div className="comment-select-all">
                      <button className="text-button" disabled={operationPending || limitReached} onClick={selectAllVisible}>
                        Выбрать все на странице
                      </button>
                      <span>Страница {currentPage} из {pageCount} · найдено {filteredSites.length.toLocaleString("ru-RU")}</span>
                    </div>
                    <div className="assignment-sites-list">
                      {visibleSites.map((site) => {
                        const checked = selectedTaskIds.includes(site.taskId);
                        return (
                          <label className={`assignment-site-option ${checked ? "assignment-site-selected" : ""}`} key={site.taskId}>
                            <input
                              type="checkbox"
                              checked={checked}
                              disabled={operationPending || (!checked && limitReached)}
                              onChange={(event) => updateSelection(site.taskId, event.target.checked)}
                            />
                            <span className="site-number">{site.siteNumber}</span>
                            <span className="site-title" title={site.title}>{site.title}</span>
                            <span className="site-assignees">{site.assignedCount} назн.</span>
                          </label>
                        );
                      })}
                    </div>
                    <div className="sites-pagination assignment-pagination">
                      <span>Показано {(currentPage - 1) * pageSize + 1}–{Math.min(currentPage * pageSize, filteredSites.length)} из {filteredSites.length.toLocaleString("ru-RU")}</span>
                      <div><button disabled={currentPage <= 1} onClick={() => setPage(currentPage - 1)}>Назад</button><span>{currentPage} / {pageCount}</span><button disabled={currentPage >= pageCount} onClick={() => setPage(currentPage + 1)}>Вперёд</button></div>
                    </div>
                  </>
                )}
        </div>

        <div className="assignment-controls">
          <div className="panel comment-text-panel">
            <div className="assignment-panel-heading">
              <div><h2>2. Текст комментария</h2><p>Один и тот же текст уйдёт во все выбранные чаты.</p></div>
            </div>
            <div className="saved-template-picker">
              <label className="field-label" htmlFor="comment-page-template">
                <span>Шаблон из настроек</span>
                <select
                  id="comment-page-template"
                  value={selectedTemplate}
                  disabled={templatesLoading || operationPending}
                  onChange={(event) => setSelectedTemplate(event.target.value)}
                >
                  <option value="">{templatesLoading ? "Загружаем шаблоны…" : "Без шаблона"}</option>
                  {commentTemplates.map((template) => (
                    <option key={template.type} value={template.type}>
                      {template.label}{template.value.trim() ? "" : " · пустой"}
                    </option>
                  ))}
                </select>
              </label>
              <button
                className="text-button"
                disabled={!selectedTemplate || templatesLoading || operationPending || !commentTemplates.find((template) => template.type === selectedTemplate)?.value.trim()}
                onClick={() => {
                  const template = commentTemplates.find((item) => item.type === selectedTemplate);
                  if (!template) return;
                  setComment(template.value);
                  setPreview(null);
                }}
              >
                Вставить
              </button>
            </div>
            {templatesError && <p className="saved-template-error">{templatesError} Текст можно написать вручную.</p>}
            <label className="field-label import-comment-field">
              <span>Комментарий</span>
              <textarea
                value={comment}
                maxLength={10_000}
                rows={6}
                disabled={operationPending}
                onChange={(event) => { setComment(event.target.value); setPreview(null); }}
                placeholder="Например: Плановые работы на площадке, подрядчик выезжает в 10:00"
              />
            </label>
            <span className="comment-character-count">{comment.length.toLocaleString("ru-RU")} / 10 000</span>
            {selectedTemplate && <p className="comment-template-hint">Переменные <code>{"${data}"}</code> и <code>{"${time}"}</code> подставляются только при назначении по XLSX. Здесь они останутся как есть — отредактируйте текст вручную.</p>}

            <button
              className="btn-primary assignment-preview-button"
              disabled={busy || operationPending || selectedTaskIds.length === 0 || !validComment || loadState !== "ready"}
              onClick={() => void requestPreview()}
            >
              {busy ? "Проверяем…" : <><ShieldCheck size={16} /> Проверить площадки</>}
            </button>
            {selectedTaskIds.length > 0 && !validComment && <span className="comment-form-hint">Введите текст комментария, чтобы продолжить.</span>}
            {limitReached && <span className="comment-form-hint">Достигнут технический предел в {maxSites.toLocaleString("ru-RU")} площадок за раз. Отправьте комментарии частями.</span>}
          </div>
        </div>
      </div>

      {preview && (
        <div className="panel xlsx-assignment-preview comment-preview-panel" ref={previewStepRef}>
          <div className="assignment-panel-heading">
            <div><h2>3. Предпросмотр</h2><p>{countRu(preview.count, siteForms)} · задачи перечитаны в YouGile</p></div>
            <span className="preview-valid-label"><CheckCircle2 size={14} /> Проверено</span>
          </div>
          <div className="preview-summary">Комментарий будет отправлен в чат каждой задачи. Ответственные не меняются, существующие сообщения сохраняются.</div>
          <blockquote className="comment-preview"><strong>Комментарий:</strong> {preview.comment}</blockquote>
          <div className="xlsx-preview-list">
            {preview.items.map((item) => (
              <div className="xlsx-preview-row comment-preview-row" key={item.taskId}>
                <span className="site-number">{item.siteNumber}</span>
                <span className="xlsx-preview-address" title={item.title}>
                  {item.title}
                  <small>{item.currentEngineers.length > 0
                    ? `Ответственные: ${item.currentEngineers.map((user) => user.name).join(", ")}`
                    : "Ответственных нет"}</small>
                </span>
                <span className={`xlsx-preview-engineer comment-last-message ${item.lastCommentError ? "comment-last-message-error" : ""}`}>
                  {item.lastCommentError
                    ? item.lastCommentError
                    : item.lastComment
                      ? item.lastComment
                      : "Комментариев пока нет"}
                  <small>{item.lastComment ? `Последний · ${formatDate(item.lastCommentAt)}` : ""}</small>
                </span>
              </div>
            ))}
          </div>
          <button className="btn-primary assignment-confirm-button" disabled={busy || operationPending || !validComment} onClick={() => void sendComments()}>
            <CheckCircle2 size={16} /> {busy ? "Запускаем…" : "Подтвердить и отправить комментарии"}
          </button>
        </div>
      )}

      {operationId && (
        <div className={`panel assignment-operation ${operation && ["SUCCEEDED", "PARTIAL", "FAILED"].includes(operation.status) ? "assignment-operation-done" : ""}`} ref={operationStepRef}>
          <div className="assignment-panel-heading">
            <div>
              <h2>
                {operation?.status === "SUCCEEDED" ? "Комментарии отправлены"
                  : operation?.status === "PARTIAL" || operation?.status === "FAILED" ? "Результат отправки"
                    : "Отправляем комментарии в YouGile"}
              </h2>
              <p>{operation?.message ?? "Операция добавлена в очередь."}</p>
            </div>
            {operation && <span className="sites-total">{operation.completed} / {operation.total}</span>}
          </div>
          {operationPending && <div className="operation-progress"><span style={{ transform: `scaleX(${operation && operation.total > 0 ? operation.completed / operation.total : 0.02})` }} /></div>}
          {operation && operation.items.length > 0 && <OperationSites items={operation.items} labelColumn="Задача" labels={siteLabels} />}
          {operationError && <p className="assignment-error">{operationError}</p>}
          {failedItems.length > 0 && (
            <div className="operation-failures">
              {failedItems.map((item) => <p key={item.siteId}>Площадка {item.siteId}: {item.errorMessage}</p>)}
            </div>
          )}
          {operation && ["SUCCEEDED", "PARTIAL", "FAILED"].includes(operation.status) && (
            <div className="comment-operation-actions">
              <button className="outline-button assignment-new-button" onClick={resetForm}><RefreshCw size={14} /> Новый комментарий</button>
              <button className="text-button" onClick={onOpenHistory}>История операций</button>
            </div>
          )}
        </div>
      )}

      <footer className="page-footer">
        <span>YouGile Operations Portal <span className="footer-version">{PORTAL_VERSION}</span></span>
        <span><MessageSquarePlus size={14} /> Каждая отправка журналируется в истории операций</span>
      </footer>
    </section>
  );
}
