import { useEffect, useLayoutEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import {
  AlertCircle,
  ArrowLeft,
  CheckCircle2,
  Code2,
  Eye,
  LoaderCircle,
  Mail,
  RefreshCw,
  Send,
  Upload
} from "lucide-react";
import { useStepScroll } from "./useStepScroll";
import { apiFetch } from "./apiClient";
import { countRu, equipmentForms, recipientForms, stepForms } from "./plural";
import { PORTAL_VERSION } from "./version";

// Список подрядчиков. Должен совпадать с contractorOptions в
// apps/api/src/modules/coordination/schema.ts — сервер проверяет поле как enum.
const contractorOptions = ["ООО «Юстас»", "ФГУП «НПП Гамма»", "ООО «РТК-Сервис»"];

type CoordinationConfig = { recipients: string[]; smtpConfigured: boolean };
type LetterPreview = {
  subject: string;
  body: string;
  fileName: string;
  extracted: {
    avrNumber: string | null;
    site: string | null;
    equipmentCount: number;
    stepsCount: number;
  };
  warnings: string[];
};
type SentLetter = { recipients: string[]; subject: string };
// Состояние панели правки таблицы: она видна, пока курсор над таблицей.
// Счётчики нужны, чтобы гасить кнопки удаления, когда строка/столбец последний.
type TableToolbarState = {
  rowCount: number;
  columnCount: number;
};

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Не удалось выполнить запрос.";
}

/**
 * Подраздел «Согласование АВР»: DOCX-план → письмо согласования АВР → SMTP.
 * Открывается карточкой на странице раздела «Согласование/Оповещение»
 * (CoordinationLandingPage) по адресу `/coordination/avr`.
 *
 * Шаги страницы: загрузка файла с реквизитами, предпросмотр с редактированием
 * темы и текста, отправка по явному подтверждению. Пока оператор не нажал
 * «Отправить письмо», наружу ничего не уходит — как и в остальных сценариях
 * портала, запись только после подтверждения.
 */
export default function CoordinationPage({ onBack }: { onBack?: () => void }) {
  const [config, setConfig] = useState<CoordinationConfig | null>(null);
  const [configError, setConfigError] = useState("");

  const [file, setFile] = useState<File | null>(null);
  const [region, setRegion] = useState("");
  const [contractor, setContractor] = useState("");
  const [workDate, setWorkDate] = useState("");

  const [preview, setPreview] = useState<LetterPreview | null>(null);
  const [bodyMode, setBodyMode] = useState<"rendered" | "source">("rendered");
  const [bodyRevision, setBodyRevision] = useState(0);
  const [tableToolbar, setTableToolbar] = useState<TableToolbarState | null>(null);
  const [sent, setSent] = useState<SentLetter | null>(null);

  const [busy, setBusy] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");

  const previewStepRef = useRef<HTMLDivElement>(null);
  const sentStepRef = useRef<HTMLDivElement>(null);
  const letterRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const latestBodyRef = useRef("");
  latestBodyRef.current = preview?.body ?? "";
  const hoverTableRef = useRef<HTMLTableElement | null>(null);
  const hoverRowRef = useRef<HTMLTableRowElement | null>(null);
  const hoverCellRef = useRef<HTMLTableCellElement | null>(null);
  const stepKey = sent ? "sent" : preview ? "preview" : null;
  const stepRef = stepKey === "sent" ? sentStepRef : previewStepRef;
  useStepScroll(stepKey, stepRef);

  useEffect(() => {
    const controller = new AbortController();
    const loadConfig = async () => {
      try {
        const response = await apiFetch("/api/coordination/config", { signal: controller.signal });
        const data = await response.json() as CoordinationConfig & { error?: string };
        if (!response.ok) throw new Error(data.error ?? "Не удалось загрузить конфигурацию оповещений.");
        setConfig({ recipients: data.recipients ?? [], smtpConfigured: Boolean(data.smtpConfigured) });
        setConfigError("");
      } catch (reason) {
        if (!controller.signal.aborted) setConfigError(errorMessage(reason));
      }
    };
    void loadConfig();
    return () => controller.abort();
  }, []);

  const canBuild = Boolean(file && region.trim() && contractor && workDate);
  const smtpReady = Boolean(config?.smtpConfigured);

  const invalidatePreview = () => {
    setPreview(null);
    setError("");
  };

  const buildLetter = async () => {
    if (!file || !canBuild || busy) return;
    setBusy(true);
    setError("");
    setPreview(null);
    setSent(null);
    try {
      const body = new FormData();
      body.append("data", file);
      body.append("region", region.trim());
      body.append("contractor", contractor);
      body.append("workDate", workDate);
      const response = await apiFetch("/api/coordination/preview", { method: "POST", body });
      const data = await response.json() as LetterPreview & { error?: string };
      if (!response.ok) throw new Error(data.error ?? "Не удалось собрать письмо из документа.");
      if (typeof data.subject !== "string" || typeof data.body !== "string") {
        throw new Error("Сервер вернул неполные данные письма.");
      }
      setPreview(data);
      setBodyMode("rendered");
      setBodyRevision((value) => value + 1);
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusy(false);
    }
  };

  const sendLetter = async () => {
    if (!preview || sending) return;
    setSending(true);
    setError("");
    try {
      const response = await apiFetch("/api/coordination/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subject: preview.subject, body: preview.body })
      });
      const data = await response.json() as { sent?: boolean; recipients?: string[]; error?: string };
      if (!response.ok || !data.sent) throw new Error(data.error ?? "Не удалось отправить письмо.");
      setSent({ recipients: data.recipients ?? [], subject: preview.subject });
      setPreview(null);
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setSending(false);
    }
  };

  const resetAll = () => {
    setFile(null);
    setRegion("");
    setContractor("");
    setWorkDate("");
    setPreview(null);
    setSent(null);
    setBodyMode("rendered");
    setError("");
  };

  const updateSubject = (subject: string) => {
    if (preview) setPreview({ ...preview, subject });
  };

  const updateBody = (nextBody: string) => {
    if (preview) setPreview({ ...preview, body: nextBody });
  };

  // В режиме «Просмотр» текст письма правится на месте (contentEditable). React не
  // должен переписывать его содержимое на каждый ввод — иначе слетает каретка, —
  // поэтому innerHTML выставляется только при сборке письма и при возврате из
  // режима «HTML-код». Сам ввод уходит в preview.body через onInput.
  useLayoutEffect(() => {
    hoverTableRef.current = null;
    hoverRowRef.current = null;
    hoverCellRef.current = null;
    setTableToolbar(null);
    if (bodyMode !== "rendered") return;
    const element = letterRef.current;
    if (element) element.innerHTML = latestBodyRef.current;
  }, [bodyMode, bodyRevision]);

  // Панель показывается, пока курсор над таблицей. Позицию меняем только через
  // ref (style), без состояния: иначе mousemove перерисовывал бы страницу на
  // каждом пикселе. Счётчики в состоянии нужны лишь для гашения кнопок удаления.
  const refreshTableToolbar = (table: HTMLTableElement, row: HTMLTableRowElement) => {
    const rowCount = table.rows.length;
    const columnCount = row.cells.length;
    setTableToolbar((prev) =>
      prev && prev.rowCount === rowCount && prev.columnCount === columnCount
        ? prev
        : { rowCount, columnCount }
    );
  };

  // Панель встаёт над наведённой ячейкой (для шапки — под ней), по центру
  // курсора. Так она не оказывается под курсором и не мешает ткнуть в ячейку, а
  // подъём на панель не задевает соседнюю строку — операция идёт по той ячейке,
  // которую пользователь видит.
  const positionToolbar = (event?: { clientX: number }) => {
    const toolbar = toolbarRef.current;
    const frame = frameRef.current;
    const cell = hoverCellRef.current;
    if (!toolbar || !frame || !cell) return;
    const frameRect = frame.getBoundingClientRect();
    const cellRect = cell.getBoundingClientRect();
    const row = cell.parentElement as HTMLTableRowElement;
    const above = row.rowIndex > 0;
    const width = toolbar.offsetWidth;
    const centerX = (event ? event.clientX : cellRect.left + cellRect.width / 2) - frameRect.left + frame.scrollLeft;
    const minLeft = frame.scrollLeft + 4;
    const maxLeft = frame.scrollLeft + frame.clientWidth - width - 4;
    const left = Math.max(minLeft, Math.min(centerX - width / 2, Math.max(minLeft, maxLeft)));
    const cellTop = cellRect.top - frameRect.top + frame.scrollTop;
    const cellBottom = cellRect.bottom - frameRect.top + frame.scrollTop;
    toolbar.style.left = `${left}px`;
    toolbar.style.top = `${above ? cellTop + 2 : cellBottom - 2}px`;
    toolbar.style.transform = above ? "translateY(-100%)" : "none";
  };

  const clearTableHover = () => {
    hoverTableRef.current = null;
    hoverRowRef.current = null;
    hoverCellRef.current = null;
    setTableToolbar(null);
  };

  const handleLetterMouseMove = (event: ReactMouseEvent<HTMLDivElement>) => {
    const cell = (event.target as HTMLElement).closest("td, th") as HTMLTableCellElement | null;
    const table = cell?.closest("table") as HTMLTableElement | null;
    const row = cell?.parentElement as HTMLTableRowElement | null;
    if (!cell || !table || !row) {
      if (hoverTableRef.current) clearTableHover();
      return;
    }
    hoverTableRef.current = table;
    hoverRowRef.current = row;
    hoverCellRef.current = cell;
    refreshTableToolbar(table, row);
    positionToolbar(event);
  };

  // Правки идут прямо в DOM письма, после чего innerHTML целиком уходит в
  // preview.body — тот же путь, что и при обычном вводе в contentEditable.
  const syncLetterBody = () => {
    const element = letterRef.current;
    if (element) updateBody(element.innerHTML);
  };

  // Панель монтируется после того, как состояние стало непустым: ставим её на
  // место сразу, не дожидаясь следующего движения мыши.
  useLayoutEffect(() => {
    if (tableToolbar) positionToolbar();
  }, [tableToolbar]);

  const copyCellShell = (reference: HTMLTableCellElement): HTMLTableCellElement => {
    const cell = document.createElement(reference.tagName.toLowerCase()) as HTMLTableCellElement;
    const className = reference.getAttribute("class");
    if (className) cell.setAttribute("class", className);
    const style = reference.getAttribute("style");
    if (style) cell.setAttribute("style", style);
    cell.appendChild(document.createElement("br"));
    return cell;
  };

  const addTableRow = () => {
    const table = hoverTableRef.current;
    const row = hoverRowRef.current;
    if (!table || !row) return;
    const newRow = document.createElement("tr");
    Array.from(row.cells).forEach((reference) => newRow.appendChild(copyCellShell(reference)));
    row.after(newRow);
    syncLetterBody();
    if (hoverRowRef.current) {
      refreshTableToolbar(table, hoverRowRef.current);
      positionToolbar();
    }
  };

  const removeTableRow = () => {
    const table = hoverTableRef.current;
    const row = hoverRowRef.current;
    if (!table || !row || table.rows.length <= 1) return;
    const rowIndex = row.rowIndex;
    const columnIndex = hoverCellRef.current?.cellIndex ?? 0;
    row.remove();
    const rows = table.rows;
    const nextRow = rows[Math.min(rowIndex, rows.length - 1)];
    hoverRowRef.current = nextRow;
    hoverCellRef.current = nextRow.cells[Math.min(columnIndex, nextRow.cells.length - 1)] ?? null;
    syncLetterBody();
    if (hoverRowRef.current) {
      refreshTableToolbar(table, hoverRowRef.current);
      positionToolbar();
    } else {
      clearTableHover();
    }
  };

  const addTableColumn = () => {
    const table = hoverTableRef.current;
    const cell = hoverCellRef.current;
    if (!table || !cell) return;
    const columnIndex = cell.cellIndex;
    const targetRow = hoverRowRef.current;
    Array.from(table.rows).forEach((row) => {
      const reference = row.cells[columnIndex];
      if (!reference) return;
      const newCell = copyCellShell(reference);
      reference.after(newCell);
      if (row === targetRow) hoverCellRef.current = newCell;
    });
    syncLetterBody();
    if (hoverRowRef.current) {
      refreshTableToolbar(table, hoverRowRef.current);
      positionToolbar();
    }
  };

  const removeTableColumn = () => {
    const table = hoverTableRef.current;
    const targetRow = hoverRowRef.current;
    if (!table || !targetRow || targetRow.cells.length <= 1) return;
    const columnIndex = hoverCellRef.current?.cellIndex ?? 0;
    Array.from(table.rows).forEach((row) => {
      const target = row.cells[columnIndex];
      if (target && row.cells.length > 1) target.remove();
    });
    hoverCellRef.current = targetRow.cells[Math.min(columnIndex, targetRow.cells.length - 1)] ?? null;
    syncLetterBody();
    refreshTableToolbar(table, targetRow);
    positionToolbar();
  };

  return (
    <section className="section-view assignment-page coordination-page">
      {onBack && (
        <button className="text-button coordination-back-button" onClick={onBack}>
          <ArrowLeft size={14} /> Все сценарии
        </button>
      )}
      <div className="eyebrow"><span className="eyebrow-line" /> ПИСЬМО СОГЛАСОВАНИЯ АВР · ОТПРАВКА ПО SMTP</div>
      <div className="sites-page-heading">
        <div>
          <h1>Согласование АВР</h1>
          <p>Загрузите DOCX-план работ — портал соберёт письмо согласования АВР. Проверьте тему и текст, затем отправьте получателям.</p>
        </div>
        {config && !sent && <span className="sites-total">{countRu(config.recipients.length, recipientForms)}</span>}
      </div>

      {error && <div className="assignment-error"><AlertCircle size={15} />{error}</div>}

      {!sent && (
        <>
          <div className="panel coordination-form-panel">
            <div className="assignment-panel-heading">
              <div>
                <h2>1. Данные письма</h2>
                <p>Из документа извлекаются номер АВР, площадка, список оборудования и алгоритм работ.</p>
              </div>
              {file && <button className="text-button" disabled={busy} onClick={resetAll}>Сбросить</button>}
            </div>

            <label className={`xlsx-dropzone coordination-dropzone ${busy ? "xlsx-dropzone-busy" : ""}`}>
              <Upload size={20} />
              <strong>{busy ? "Разбираем документ…" : file ? file.name : "Выберите файл .docx"}</strong>
              <span>{busy ? "Пожалуйста, подождите" : file ? "Файл готов к разбору" : "Word-документ с планом работ: таблицы оборудования и регламента"}</span>
              <input
                type="file"
                accept=".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                disabled={busy}
                onChange={(event) => {
                  const next = event.currentTarget.files?.[0];
                  event.currentTarget.value = "";
                  if (next) {
                    setFile(next);
                    invalidatePreview();
                  }
                }}
              />
            </label>

            <div className="coordination-fields">
              <label className="field-label" htmlFor="coordination-region">
                <span>Регион</span>
                <input
                  id="coordination-region"
                  value={region}
                  maxLength={200}
                  disabled={busy}
                  placeholder="Например: Центральный"
                  onChange={(event) => { setRegion(event.target.value); invalidatePreview(); }}
                />
              </label>
              <label className="field-label" htmlFor="coordination-contractor">
                <span>Подрядная организация</span>
                <select
                  id="coordination-contractor"
                  value={contractor}
                  disabled={busy}
                  onChange={(event) => { setContractor(event.target.value); invalidatePreview(); }}
                >
                  <option value="">Выберите подрядчика</option>
                  {contractorOptions.map((option) => <option key={option} value={option}>{option}</option>)}
                </select>
              </label>
              <label className="field-label" htmlFor="coordination-work-date">
                <span>День работ</span>
                <input
                  id="coordination-work-date"
                  type="date"
                  value={workDate}
                  disabled={busy}
                  onChange={(event) => { setWorkDate(event.target.value); invalidatePreview(); }}
                />
              </label>
            </div>

            <button className="btn-primary coordination-build-button" disabled={busy || !canBuild} onClick={() => void buildLetter()}>
              {busy
                ? <><LoaderCircle size={15} className="template-spinner" /> Собираем письмо…</>
                : <><Send size={15} /> {preview ? "Пересобрать письмо" : "Сформировать письмо"}</>}
            </button>
            {!canBuild && !busy && (
              <span className="coordination-form-hint">Загрузите DOCX-файл и заполните регион, подрядчика и день работ.</span>
            )}
          </div>

          {configError && <div className="assignment-error"><AlertCircle size={15} />{configError}</div>}

          {preview && (
            <div className="panel coordination-preview-panel" ref={previewStepRef}>
              <div className="assignment-panel-heading">
                <div>
                  <h2>2. Предпросмотр письма</h2>
                  <p>{preview.fileName} · тему и текст можно отредактировать перед отправкой, а таблицу — дополнить строками и столбцами</p>
                </div>
                <span className="preview-valid-label"><CheckCircle2 size={14} /> Готово к отправке</span>
              </div>

              <div className="coordination-meta">
                <span>{preview.extracted.avrNumber ? `АВР №${preview.extracted.avrNumber}` : "АВР не найден"}</span>
                <span>{preview.extracted.site ? `Площадка ID ${preview.extracted.site}` : "Площадка не найдена"}</span>
                <span>{countRu(preview.extracted.equipmentCount, equipmentForms)} оборудования</span>
                <span>{countRu(preview.extracted.stepsCount, stepForms)} алгоритма</span>
              </div>

              {preview.warnings.length > 0 && (
                <div className="coordination-warnings">
                  {preview.warnings.map((warning) => (
                    <div className="coordination-warning" key={warning}><AlertCircle size={14} />{warning}</div>
                  ))}
                </div>
              )}

              <div className={`coordination-recipients ${smtpReady ? "" : "coordination-recipients-off"}`}>
                <Mail size={14} />
                <span>
                  {config ? <>Кому: {config.recipients.join(", ")}</> : "Загружаем получателей…"}
                  {!smtpReady && " · SMTP не настроен — отправка недоступна"}
                </span>
              </div>

              <label className="field-label coordination-subject-field" htmlFor="coordination-subject">
                <span>Тема письма</span>
                <input
                  id="coordination-subject"
                  value={preview.subject}
                  maxLength={500}
                  onChange={(event) => updateSubject(event.target.value)}
                />
              </label>

              <div className="coordination-body-heading">
                <span className="coordination-body-label">Текст письма</span>
                <div className="coordination-mode-switch" role="tablist" aria-label="Режим отображения письма">
                  <button
                    type="button"
                    role="tab"
                    aria-selected={bodyMode === "rendered"}
                    className={bodyMode === "rendered" ? "coordination-mode-active" : ""}
                    onClick={() => setBodyMode("rendered")}
                  >
                    <Eye size={13} /> Просмотр
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={bodyMode === "source"}
                    className={bodyMode === "source" ? "coordination-mode-active" : ""}
                    onClick={() => setBodyMode("source")}
                  >
                    <Code2 size={13} /> HTML-код
                  </button>
                </div>
              </div>

              {bodyMode === "rendered" ? (
                <div className="coordination-letter-frame" ref={frameRef} onMouseLeave={clearTableHover}>
                  <div
                    ref={letterRef}
                    className="coordination-letter coordination-letter-editable"
                    contentEditable
                    suppressContentEditableWarning
                    role="textbox"
                    aria-multiline="true"
                    aria-label="Текст письма"
                    onInput={(event) => updateBody(event.currentTarget.innerHTML)}
                    onMouseMove={handleLetterMouseMove}
                  />
                  {tableToolbar && (
                    <div
                      ref={toolbarRef}
                      className="coordination-table-toolbar"
                      role="toolbar"
                      aria-label="Правка таблицы письма"
                    >
                      <button type="button" title="Добавить строку ниже" onClick={addTableRow}>+ строка</button>
                      <button
                        type="button"
                        title="Удалить строку"
                        disabled={tableToolbar.rowCount <= 1}
                        onClick={removeTableRow}
                      >
                        − строка
                      </button>
                      <button type="button" title="Добавить столбец справа" onClick={addTableColumn}>+ столбец</button>
                      <button
                        type="button"
                        title="Удалить столбец"
                        disabled={tableToolbar.columnCount <= 1}
                        onClick={removeTableColumn}
                      >
                        − столбец
                      </button>
                    </div>
                  )}
                </div>
              ) : (
                <textarea
                  className="coordination-body-source"
                  value={preview.body}
                  rows={16}
                  maxLength={100_000}
                  onChange={(event) => updateBody(event.target.value)}
                  aria-label="HTML-код письма"
                />
              )}

              <div className="coordination-preview-actions">
                <button
                  className="btn-primary"
                  disabled={sending || !smtpReady || !preview.subject.trim() || !preview.body.trim()}
                  onClick={() => void sendLetter()}
                >
                  {sending ? <><LoaderCircle size={15} className="template-spinner" /> Отправляем…</> : <><Send size={15} /> Отправить письмо</>}
                </button>
                <button className="text-button" disabled={sending} onClick={() => setPreview(null)}>
                  Изменить данные
                </button>
              </div>
              {!smtpReady && <span className="coordination-form-hint">Отправка включается настройкой SMTP-сервера в «Конфигурация портала» → «Оповещения».</span>}
            </div>
          )}
        </>
      )}

      {sent && (
        <div className="panel coordination-result-panel" ref={sentStepRef}>
          <div className="assignment-panel-heading">
            <div>
              <h2>Письмо отправлено</h2>
              <p>Тема: {sent.subject}</p>
            </div>
            <span className="preview-valid-label"><CheckCircle2 size={14} /> Отправлено</span>
          </div>
          <div className="coordination-result-body">
            <CheckCircle2 size={17} />
            <span>
              Письмо ушло получателям: {sent.recipients.join(", ") || "—"}
              {" · "}{countRu(sent.recipients.length, recipientForms)}
            </span>
          </div>
          <div className="coordination-preview-actions">
            <button className="outline-button" onClick={resetAll}><RefreshCw size={14} /> Новое письмо</button>
          </div>
        </div>
      )}

      <footer className="page-footer">
        <span>YouGile Operations Portal <span className="footer-version">{PORTAL_VERSION}</span></span>
        <span><Mail size={14} /> Получатели настраиваются в разделе «Конфигурация портала», отправка журналируется</span>
      </footer>
    </section>
  );
}
