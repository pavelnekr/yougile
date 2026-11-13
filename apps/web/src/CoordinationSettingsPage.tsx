import { useEffect, useRef, useState } from "react";
import { ArrowLeft, CheckCircle2, LoaderCircle, Plus, Save, Trash2 } from "lucide-react";
import { apiFetch } from "./apiClient";
import OperatorContactsSettings from "./OperatorContactsSettings.js";
import { PORTAL_VERSION } from "./version";

const defaultTemplate = { subject: "", body: "" };

export default function CoordinationSettingsPage({ onBack }: { onBack: () => void }) {
  const [template, setTemplate] = useState(defaultTemplate);
  const [savedTemplate, setSavedTemplate] = useState(defaultTemplate);
  const [ccRecipients, setCcRecipients] = useState<string[]>([]);
  const [savedCcRecipients, setSavedCcRecipients] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [savingCc, setSavingCc] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [activeTab, setActiveTab] = useState<"avr" | "operators">("avr");
  const bodyEditorRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const controller = new AbortController();
    void apiFetch("/api/coordination/config", { signal: controller.signal })
      .then(async (response) => {
        const data = await response.json() as { template?: typeof defaultTemplate; ccRecipients?: string[]; error?: string };
        if (!response.ok) throw new Error(data.error ?? "Не удалось загрузить настройки.");
        const nextTemplate = data.template ?? defaultTemplate;
        setTemplate(nextTemplate); setSavedTemplate(nextTemplate);
        const nextCc = Array.isArray(data.ccRecipients) ? data.ccRecipients : [];
        setCcRecipients(nextCc); setSavedCcRecipients(nextCc);
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

  const saveCcRecipients = async () => {
    if (savingCc) return;
    const recipients = ccRecipients.map((address) => address.trim());
    const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (recipients.some((address) => !emailPattern.test(address))) {
      setError("Проверьте адреса электронной почты для копии."); setNotice(""); return;
    }
    if (new Set(recipients.map((address) => address.toLowerCase())).size !== recipients.length) {
      setError("Адреса для копии не должны повторяться."); setNotice(""); return;
    }
    setSavingCc(true); setError(""); setNotice("");
    try {
      const response = await apiFetch("/api/coordination/avr-cc-recipients", {
        method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ recipients })
      });
      const data = await response.json() as { recipients?: string[]; error?: string };
      if (!response.ok || !data.recipients) throw new Error(data.error ?? "Не удалось сохранить адреса для копии.");
      setCcRecipients(data.recipients); setSavedCcRecipients(data.recipients); setNotice("Адреса для копии сохранены.");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Не удалось сохранить адреса для копии."); }
    finally { setSavingCc(false); }
  };

  return (
    <section className="section-view coordination-settings-page">
      <div className="eyebrow"><span className="eyebrow-line" /> СОГЛАСОВАНИЕ/ОПОВЕЩЕНИЕ</div>
      <div className="sites-page-heading">
        <div><h1>Настройки</h1><p>Шаблон письма и справочник адресов операторов для этого рабочего пространства.</p></div>
        <button className="text-button" type="button" onClick={onBack}><ArrowLeft size={14} /> Назад</button>
      </div>

      <div className="panel coordination-settings-panel">
        <div className="portal-config-tabs" aria-label="Настройки по сценариям">
          <div className="portal-config-tab-group" role="tablist" aria-label="Согласование/Оповещение">
            <span className="portal-config-tab-group-label" role="presentation">Согласование/Оповещение</span>
            <button id="coordination-settings-tab-avr" type="button" role="tab" aria-selected={activeTab === "avr"} aria-controls="coordination-settings-panel-avr" className={`portal-config-tab ${activeTab === "avr" ? "portal-config-tab-active" : ""}`} onClick={() => setActiveTab("avr")}>
              Согласование АВР
            </button>
            <button id="coordination-settings-tab-operators" type="button" role="tab" aria-selected={activeTab === "operators"} aria-controls="coordination-settings-panel-operators" className={`portal-config-tab ${activeTab === "operators" ? "portal-config-tab-active" : ""}`} onClick={() => setActiveTab("operators")}>
              Email операторов
            </button>
          </div>
        </div>
        <section className="portal-config-section" id="coordination-settings-panel-avr" role="tabpanel" aria-labelledby="coordination-settings-tab-avr" hidden={activeTab !== "avr"}>
        {loading ? <div className="portal-config-loading"><LoaderCircle size={16} className="template-spinner" /> Загружаем настройки…</div> : <>
        <section className="coordination-settings-subsection">
          <h2>Адресаты писем</h2>
          <p>Адреса операторов автоматически подбираются по номеру площадки из DOCX. Дополнительные адреса пользователей будут добавлены в поле «Копия» каждого нового письма.</p>
          <div className="portal-config-list">
            <div className="portal-config-row portal-config-row-head portal-config-row-single" aria-hidden="true"><span>Адрес пользователя для копии</span><span /></div>
            {ccRecipients.map((address, index) => <div className="portal-config-row portal-config-row-single" key={index}>
              <input type="email" value={address} maxLength={254} disabled={savingCc} placeholder="name@example.ru" aria-label={`Адрес для копии, строка ${index + 1}`} onChange={(event) => setCcRecipients((current) => current.map((item, position) => position === index ? event.target.value : item))} />
              <button type="button" className="icon-button portal-config-row-remove" disabled={savingCc} aria-label={`Удалить адрес, строка ${index + 1}`} onClick={() => setCcRecipients((current) => current.filter((_, position) => position !== index))}><Trash2 size={15} /></button>
            </div>)}
          </div>
          <div className="portal-config-actions">
            <button type="button" className="outline-button" disabled={savingCc || ccRecipients.length >= 20} onClick={() => setCcRecipients((current) => [...current, ""])}><Plus size={14} /> Добавить адрес</button>
            <button type="button" className="btn-primary" disabled={savingCc || JSON.stringify(ccRecipients) === JSON.stringify(savedCcRecipients)} onClick={() => void saveCcRecipients()}>{savingCc ? <LoaderCircle size={15} className="template-spinner" /> : <Save size={15} />}{savingCc ? "Сохраняем…" : "Сохранить адреса"}</button>
          </div>
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
        <section className="portal-config-section operator-contacts-panel" id="coordination-settings-panel-operators" role="tabpanel" aria-labelledby="coordination-settings-tab-operators" hidden={activeTab !== "operators"}>
          {activeTab === "operators" && <OperatorContactsSettings />}
        </section>
      </div>
      <footer className="page-footer"><span>YouGile Operations Portal <span className="footer-version">{PORTAL_VERSION}</span></span><span>Изменения применяются к новым письмам</span></footer>
    </section>
  );
}
