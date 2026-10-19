import { useEffect, useRef, useState } from "react";
import { ArrowLeft, CheckCircle2, LoaderCircle, Plus, Save, Trash2 } from "lucide-react";
import { apiFetch } from "./apiClient";
import { PORTAL_VERSION } from "./version";

const defaultTemplate = { subject: "", body: "" };

export default function CoordinationSettingsPage({ onBack }: { onBack: () => void }) {
  const [recipients, setRecipients] = useState<string[]>([]);
  const [savedRecipients, setSavedRecipients] = useState<string[]>([]);
  const [template, setTemplate] = useState(defaultTemplate);
  const [savedTemplate, setSavedTemplate] = useState(defaultTemplate);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const bodyEditorRef = useRef<HTMLDivElement>(null);
  const recipientsChanged = JSON.stringify(recipients) !== JSON.stringify(savedRecipients);

  useEffect(() => {
    const controller = new AbortController();
    void apiFetch("/api/coordination/config", { signal: controller.signal })
      .then(async (response) => {
        const data = await response.json() as { recipients?: string[]; template?: typeof defaultTemplate; error?: string };
        if (!response.ok) throw new Error(data.error ?? "Не удалось загрузить настройки.");
        const nextRecipients = data.recipients ?? [];
        const nextTemplate = data.template ?? defaultTemplate;
        setRecipients(nextRecipients); setSavedRecipients(nextRecipients);
        setTemplate(nextTemplate); setSavedTemplate(nextTemplate);
      })
      .catch((reason: unknown) => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "Не удалось загрузить настройки."); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (!loading && bodyEditorRef.current) bodyEditorRef.current.innerHTML = template.body;
  }, [loading]);

  const saveSettings = async () => {
    if (saving) return;
    const nextTemplate = {
      ...template,
      body: bodyEditorRef.current?.innerHTML ?? template.body
    };
    const templateChanged = nextTemplate.subject !== savedTemplate.subject || nextTemplate.body !== savedTemplate.body;
    setSaving(true); setError(""); setNotice("");
    try {
      if (recipientsChanged) {
        const response = await apiFetch("/api/coordination/recipients", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ recipients: recipients.map((item) => item.trim()) }) });
        const data = await response.json() as { recipients?: string[]; error?: string };
        if (!response.ok || !data.recipients) throw new Error(data.error ?? "Не удалось сохранить получателей.");
        setRecipients(data.recipients); setSavedRecipients(data.recipients);
      }
      if (templateChanged) {
        const response = await apiFetch("/api/coordination/template", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(nextTemplate) });
        const data = await response.json() as { template?: typeof defaultTemplate; error?: string };
        if (!response.ok || !data.template) throw new Error(data.error ?? "Не удалось сохранить шаблон.");
        setTemplate(data.template); setSavedTemplate(data.template);
        if (bodyEditorRef.current) bodyEditorRef.current.innerHTML = data.template.body;
      }
      setNotice("Настройки сохранены.");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Не удалось сохранить настройки."); }
    finally { setSaving(false); }
  };

  return (
    <section className="section-view coordination-settings-page">
      <div className="eyebrow"><span className="eyebrow-line" /> СОГЛАСОВАНИЕ/ОПОВЕЩЕНИЕ</div>
      <div className="sites-page-heading">
        <div><h1>Настройки</h1><p>Получатели писем и шаблон письма для сценариев этого рабочего пространства.</p></div>
        <button className="text-button" type="button" onClick={onBack}><ArrowLeft size={14} /> Назад</button>
      </div>

      <div className="panel coordination-settings-panel">
        <div className="portal-config-tabs" aria-label="Настройки по сценариям">
          <div className="portal-config-tab-group" role="tablist" aria-label="Согласование/Оповещение">
            <span className="portal-config-tab-group-label" role="presentation">Согласование/Оповещение</span>
            <button id="coordination-settings-tab-avr" type="button" role="tab" aria-selected="true" aria-controls="coordination-settings-panel-avr" className="portal-config-tab portal-config-tab-active">
              Согласование АВР
            </button>
          </div>
        </div>
        <section className="portal-config-section" id="coordination-settings-panel-avr" role="tabpanel" aria-labelledby="coordination-settings-tab-avr">
        {loading ? <div className="portal-config-loading"><LoaderCircle size={16} className="template-spinner" /> Загружаем настройки…</div> : <>
        <section className="coordination-settings-subsection">
          <h2>Получатели писем</h2>
          <p>Список адресов, на которые отправляются письма согласования.</p>
          {recipients.map((address, index) => <div className="portal-config-row portal-config-row-single" key={index}>
            <input type="email" value={address} maxLength={254} placeholder="name@example.ru" aria-label={`Адрес получателя, строка ${index + 1}`} onChange={(event) => setRecipients((current) => current.map((item, i) => i === index ? event.target.value : item))} />
            <button className="icon-button portal-config-row-remove" type="button" aria-label={`Удалить адрес, строка ${index + 1}`} onClick={() => setRecipients((current) => current.filter((_, i) => i !== index))}><Trash2 size={15} /></button>
          </div>)}
          <button type="button" className="outline-button" disabled={recipients.length >= 20} onClick={() => setRecipients((current) => [...current, ""])}><Plus size={14} /> Добавить адрес</button>
        </section>
        <section className="coordination-settings-subsection">
          <h2>Шаблон письма</h2>
          <p>Текст в фигурных скобках подставляется из DOCX и формы: <code>{"{{avrNumber}}"}</code>, <code>{"{{site}}"}</code>, <code>{"{{region}}"}</code>, <code>{"{{contractor}}"}</code>, <code>{"{{workDate}}"}</code>, <code>{"{{equipmentList}}"}</code>, <code>{"{{algoTable}}"}</code>.</p>
          <label>Шаблон темы<input value={template.subject} maxLength={500} onChange={(event) => setTemplate((current) => ({ ...current, subject: event.target.value }))} /></label>
          <label>Шаблон письма
            <div
              ref={bodyEditorRef}
              className="coordination-template-editor"
              contentEditable
              suppressContentEditableWarning
              role="textbox"
              aria-label="Шаблон письма"
              aria-multiline="true"
            />
          </label>
        </section>
        {error && <div className="portal-config-feedback portal-config-feedback-error" role="alert">{error}</div>}
        {notice && <div className="portal-config-feedback portal-config-feedback-success" role="status"><CheckCircle2 size={15} />{notice}</div>}
        <div className="portal-config-actions"><button type="button" className="btn-primary" disabled={loading || saving} onClick={() => void saveSettings()}>{saving ? <LoaderCircle size={15} className="template-spinner" /> : <Save size={15} />}{saving ? "Сохраняем…" : "Сохранить"}</button></div>
        </>}
        </section>
      </div>
      <footer className="page-footer"><span>YouGile Operations Portal <span className="footer-version">{PORTAL_VERSION}</span></span><span>Изменения применяются к новым письмам</span></footer>
    </section>
  );
}
