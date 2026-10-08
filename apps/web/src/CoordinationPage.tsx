import { useEffect, useRef, useState } from "react";
import {
  AlertCircle,
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

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Не удалось выполнить запрос.";
}

/**
 * Раздел «Согласование/Оповещение»: DOCX-план → письмо согласования АВР → SMTP.
 *
 * Шаги страницы: загрузка файла с реквизитами, предпросмотр с редактированием
 * темы и текста, отправка по явному подтверждению. Пока оператор не нажал
 * «Отправить письмо», наружу ничего не уходит — как и в остальных сценариях
 * портала, запись только после подтверждения.
 */
export default function CoordinationPage() {
  const [config, setConfig] = useState<CoordinationConfig | null>(null);
  const [configError, setConfigError] = useState("");

  const [file, setFile] = useState<File | null>(null);
  const [region, setRegion] = useState("");
  const [contractor, setContractor] = useState("");
  const [workDate, setWorkDate] = useState("");

  const [preview, setPreview] = useState<LetterPreview | null>(null);
  const [bodyMode, setBodyMode] = useState<"rendered" | "source">("rendered");
  const [sent, setSent] = useState<SentLetter | null>(null);

  const [busy, setBusy] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");

  const previewStepRef = useRef<HTMLDivElement>(null);
  const sentStepRef = useRef<HTMLDivElement>(null);
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

  return (
    <section className="section-view assignment-page coordination-page">
      <div className="eyebrow"><span className="eyebrow-line" /> ПИСЬМО СОГЛАСОВАНИЯ АВР · ОТПРАВКА ПО SMTP</div>
      <div className="sites-page-heading">
        <div>
          <h1>Согласование/Оповещение</h1>
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
                  <p>{preview.fileName} · тему и текст можно отредактировать перед отправкой</p>
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
                <div className="coordination-letter" dangerouslySetInnerHTML={{ __html: preview.body }} />
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
              {!smtpReady && <span className="coordination-form-hint">Отправка включается переменной SMTP_HOST в настройках портала.</span>}
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
