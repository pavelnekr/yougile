import { useEffect, useRef, useState } from "react";
import { ArrowLeft, CheckCircle2, LoaderCircle, Save } from "lucide-react";
import { apiFetch } from "./apiClient";
import OperatorContactsSettings from "./OperatorContactsSettings.js";
import { PORTAL_VERSION } from "./version";

const defaultTemplate = { subject: "", body: "" };

export default function CoordinationSettingsPage({ onBack }: { onBack: () => void }) {
  const [template, setTemplate] = useState(defaultTemplate);
  const [savedTemplate, setSavedTemplate] = useState(defaultTemplate);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [activeTab, setActiveTab] = useState<"avr" | "operators">("avr");
  const bodyEditorRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const controller = new AbortController();
    void apiFetch("/api/coordination/config", { signal: controller.signal })
      .then(async (response) => {
        const data = await response.json() as { template?: typeof defaultTemplate; error?: string };
        if (!response.ok) throw new Error(data.error ?? "Не удалось загрузить настройки.");
        const nextTemplate = data.template ?? defaultTemplate;
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
          <p>Адреса автоматически подбираются по номеру площадки из DOCX и справочника в подразделе «Email операторов». Перед отправкой справочник проверяется повторно.</p>
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
