import { useEffect, useMemo, useState } from "react";
import { Check, CheckCircle2, Clock3, FileText, LoaderCircle, Plus, Save, Sparkles, Trash2 } from "lucide-react";
import { apiFetch } from "./apiClient";
import ConfirmDialog from "./ConfirmDialog";
import Modal from "./Modal";
import { PORTAL_VERSION } from "./version";

type CommentTemplate = {
  type: string;
  label: string;
  description: string;
  workType: string;
  isCustom: boolean;
  value: string;
  updatedAt: string | null;
};

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Не удалось выполнить запрос.";
}

function formatUpdatedAt(value: string | null) {
  if (!value) return "Ещё не сохранялся";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "Сохранён";
  return `Сохранён ${date.toLocaleString("ru-RU", { dateStyle: "medium", timeStyle: "short" })}`;
}

export default function CommentTemplatesPage() {
  const [templates, setTemplates] = useState<CommentTemplate[]>([]);
  const [selectedType, setSelectedType] = useState("filter");
  const [draft, setDraft] = useState("");
  const [savedValue, setSavedValue] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [pendingSwitch, setPendingSwitch] = useState<CommentTemplate | null>(null);
  const [pendingDelete, setPendingDelete] = useState<CommentTemplate | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [newLabel, setNewLabel] = useState("");
  const [newValue, setNewValue] = useState("");
  const [createError, setCreateError] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    const load = async () => {
      try {
        const response = await apiFetch("/api/settings/comment-templates", { signal: controller.signal });
        const data = await response.json() as { templates?: CommentTemplate[]; error?: string };
        if (!response.ok) throw new Error(data.error ?? "Не удалось загрузить шаблоны.");
        if (!data.templates) throw new Error("Сервер не вернул список шаблонов.");
        setTemplates(data.templates);
        const first = data.templates.find((item) => item.type === selectedType);
        setDraft(first?.value ?? "");
        setSavedValue(first?.value ?? "");
      } catch (reason) {
        if (!controller.signal.aborted) setError(errorMessage(reason));
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    };
    void load();
    return () => controller.abort();
  }, []);

  const selected = templates.find((template) => template.type === selectedType);
  const changed = draft !== savedValue;
  const preview = useMemo(() => draft
    .split("${data}").join("02.10.2026-03.10.2026")
    .split("${time}").join("00:00-06:00"), [draft]);

  const applyTemplate = (template: CommentTemplate) => {
    setSelectedType(template.type);
    setDraft(template.value);
    setSavedValue(template.value);
    setError("");
    setNotice("");
    setPendingSwitch(null);
  };

  // Несохранённый текст нельзя потерять молча, но и window.confirm здесь неуместен:
  // системный диалог выглядит чужеродно и обрывает анимации страницы.
  const selectTemplate = (template: CommentTemplate) => {
    if (changed) {
      setPendingSwitch(template);
      return;
    }
    applyTemplate(template);
  };

  const saveTemplate = async () => {
    if (!selected || saving || !changed || draft.length > 10_000) return;
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const response = await apiFetch(`/api/settings/comment-templates/${selected.type}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: draft })
      });
      const data = await response.json() as { template?: CommentTemplate; error?: string };
      if (!response.ok) throw new Error(data.error ?? "Не удалось сохранить шаблон.");
      if (!data.template) throw new Error("Сервер не вернул сохранённый шаблон.");
      setTemplates((current) => current.map((item) => item.type === data.template!.type ? data.template! : item));
      setDraft(data.template.value);
      setSavedValue(data.template.value);
      setNotice("Шаблон сохранён.");
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setSaving(false);
    }
  };

  const createTemplate = async () => {
    if (creating || !newLabel.trim() || newLabel.trim().length > 80 || newValue.length > 10_000) return;
    setCreating(true);
    setCreateError("");
    try {
      const response = await apiFetch("/api/settings/comment-templates", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label: newLabel, value: newValue })
      });
      const data = await response.json() as { template?: CommentTemplate; error?: string };
      if (!response.ok) throw new Error(data.error ?? "Не удалось создать шаблон.");
      if (!data.template) throw new Error("Сервер не вернул созданный шаблон.");
      setTemplates((current) => [...current, data.template!]);
      setSelectedType(data.template.type);
      setDraft(data.template.value);
      setSavedValue(data.template.value);
      setShowCreate(false);
      setNewLabel("");
      setNewValue("");
      setNotice("Дополнительный шаблон создан.");
      setError("");
    } catch (reason) {
      setCreateError(errorMessage(reason));
    } finally {
      setCreating(false);
    }
  };

  const deleteTemplate = async (template: CommentTemplate) => {
    if (deleting) return;
    setDeleting(true);
    setError("");
    setNotice("");
    try {
      const response = await apiFetch(`/api/settings/comment-templates/${encodeURIComponent(template.type)}`, {
        method: "DELETE"
      });
      if (!response.ok) {
        const data = await response.json() as { error?: string };
        throw new Error(data.error ?? "Не удалось удалить шаблон.");
      }
      const remaining = templates.filter((item) => item.type !== template.type);
      const next = remaining.find((item) => item.type === "filter") ?? remaining[0];
      setTemplates(remaining);
      if (selectedType === template.type && next) applyTemplate(next);
      setNotice("Дополнительный шаблон удалён.");
      setPendingDelete(null);
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setDeleting(false);
    }
  };

  return (
    <section className="section-view comment-templates-page">
      <div className="eyebrow"><span className="eyebrow-line" /> НАСТРОЙКИ РАБОЧИХ ПРОЦЕССОВ</div>
      <div className="section-hero">
        <span className="section-hero-icon"><FileText size={22} /></span>
        <div><h1>Шаблоны комментариев</h1><p>Редактируйте стандартные шаблоны и добавляйте свои для назначения по XLSX и отправки комментариев.</p></div>
      </div>

      <div className="template-editor-layout">
        <aside className="panel template-selector-panel" aria-label="Типы работ">
          <div className="template-selector-heading"><span>ШАБЛОНЫ</span>
            <button className="text-button template-add-button" onClick={() => { setShowCreate(true); setCreateError(""); }}>
              <Plus size={13} /> Добавить
            </button>
          </div>
          {loading ? (
            <div className="template-loading"><LoaderCircle size={16} className="template-spinner" /> Загружаем шаблоны…</div>
          ) : templates.map((template) => (
            <button
              className={`template-option ${selectedType === template.type ? "template-option-active" : ""}`}
              key={template.type}
              onClick={() => selectTemplate(template)}
              aria-pressed={selectedType === template.type}
            >
              <span className="template-option-icon"><FileText size={16} /></span>
              <span className="template-option-copy"><strong>{template.label}</strong><small>{template.description}</small></span>
              <span className={`template-status ${template.value.trim() ? "template-status-ready" : ""}`}>
                {template.value.trim() ? <><Check size={11} /> Готов</> : "Пустой"}
              </span>
            </button>
          ))}
          <div className="template-selector-tip"><Sparkles size={15} /><span>Дополнительные шаблоны доступны при назначении и отправке комментариев. В статистике XLSX они учитываются как «Другое».</span></div>
        </aside>

        <div className="panel template-editor-panel">
          {selected ? (
            <>
              <div className="template-editor-heading">
                <div><span className="template-editor-kicker">ШАБЛОН КОММЕНТАРИЯ</span><h2>{selected.label}</h2><p>{selected.description}</p></div>
                <span className={`template-save-state ${changed ? "template-save-state-dirty" : ""}`}>
                  {changed ? "Есть несохранённые изменения" : formatUpdatedAt(selected.updatedAt)}
                </span>
              </div>

              <label className="template-editor-label" htmlFor="comment-template-editor">Текст шаблона</label>
              <textarea
                id="comment-template-editor"
                className="template-editor-textarea"
                value={draft}
                maxLength={10_000}
                disabled={loading || saving}
                onChange={(event) => { setDraft(event.target.value); setNotice(""); }}
                placeholder={"Например: Плановые работы ${data}, время ${time}"}
              />
              <div className="template-editor-meta"><span>Переменные подставляются из колонок XLSX</span><span>{draft.length.toLocaleString("ru-RU")} / 10 000</span></div>

              <div className="template-variables">
                <div><code>{"${data}"}</code><span>Дата из XLSX; для «ночи» — дата и следующий день.</span></div>
                <div><code>{"${time}"}</code><span>Временной интервал из XLSX.</span></div>
              </div>

              <div className="template-live-preview">
                <div className="template-preview-heading"><span><Sparkles size={14} /> Пример подстановки</span><small>ночь · 02.10.2026 · 00:00–06:00</small></div>
                <p>{preview || "Начните вводить текст шаблона — здесь появится пример комментария."}</p>
              </div>

              {error && <div className="template-feedback template-feedback-error" role="alert">{error}</div>}
              {notice && <div className="template-feedback template-feedback-success" role="status"><CheckCircle2 size={15} />{notice}</div>}

              <div className="template-editor-actions">
                <span className="template-last-saved"><Clock3 size={13} /> {formatUpdatedAt(selected.updatedAt)}</span>
                <button className="btn-primary template-save-button" disabled={loading || saving || !changed || draft.length > 10_000} onClick={() => void saveTemplate()}>
                  {saving ? <LoaderCircle size={15} className="template-spinner" /> : <Save size={15} />}
                  {saving ? "Сохраняем…" : "Сохранить шаблон"}
                </button>
                {selected.isCustom && <button className="text-button template-delete-button" disabled={saving || deleting} onClick={() => setPendingDelete(selected)}>
                  <Trash2 size={14} /> Удалить
                </button>}
              </div>
            </>
          ) : (
            <div className="template-loading"><LoaderCircle size={16} className="template-spinner" /> Подготавливаем редактор…</div>
          )}
        </div>
      </div>
      {pendingSwitch && (
        <ConfirmDialog
          title="Несохранённые изменения"
          confirmLabel="Переключить и отменить"
          onConfirm={() => applyTemplate(pendingSwitch)}
          onCancel={() => setPendingSwitch(null)}
        >
          В шаблоне «{pendingSwitch.label}» есть изменения, которые не сохранены.
          {" "}При переключении они пропадут. Сохраните их кнопкой выше, если они нужны.
        </ConfirmDialog>
      )}
      {pendingDelete && (
        <ConfirmDialog
          title="Удалить дополнительный шаблон?"
          confirmLabel={deleting ? "Удаляем…" : "Удалить шаблон"}
          onConfirm={() => void deleteTemplate(pendingDelete)}
          onCancel={() => { if (!deleting) setPendingDelete(null); }}
        >
          Шаблон «{pendingDelete.label}» будет удалён и исчезнет из списков выбора комментариев.
          {pendingDelete.type === selectedType && changed ? " Несохранённые изменения также будут потеряны." : ""}
        </ConfirmDialog>
      )}
      {showCreate && (
        <Modal labelledBy="create-template-title" onDismiss={() => { if (!creating) setShowCreate(false); }}>
          <div className="dialog-heading"><span className="dialog-icon"><FileText size={17} /></span><div><h2 id="create-template-title">Новый шаблон</h2></div></div>
          <div className="dialog-body template-create-form">
            <label className="field-label" htmlFor="new-template-name"><span>Название</span>
              <input id="new-template-name" value={newLabel} maxLength={80} disabled={creating}
                onChange={(event) => setNewLabel(event.target.value)} placeholder="Например, Замена оборудования" />
            </label>
            <label className="field-label" htmlFor="new-template-text"><span>Текст шаблона</span>
              <textarea id="new-template-text" value={newValue} maxLength={10_000} disabled={creating}
                onChange={(event) => setNewValue(event.target.value)} placeholder="Текст комментария, можно использовать ${data} и ${time}" />
            </label>
            <div className="template-editor-meta"><span>В XLSX-шаблоны подставляются данные из плана</span><span>{newValue.length.toLocaleString("ru-RU")} / 10 000</span></div>
            {createError && <div className="template-feedback template-feedback-error" role="alert">{createError}</div>}
          </div>
          <div className="dialog-actions">
            <button className="text-button" disabled={creating} onClick={() => setShowCreate(false)}>Отмена</button>
            <button className="btn-primary" disabled={creating || !newLabel.trim() || newValue.length > 10_000} onClick={() => void createTemplate()}>
              {creating ? "Создаём…" : "Создать шаблон"}
            </button>
          </div>
        </Modal>
      )}
      <footer className="page-footer"><span>YouGile Operations Portal <span className="footer-version">{PORTAL_VERSION}</span></span><span>Шаблоны хранятся на сервере</span></footer>
    </section>
  );
}
