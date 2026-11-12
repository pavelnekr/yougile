import { useEffect, useState } from "react";
import { ArrowLeft, CalendarDays, CheckCircle2, ClipboardList, LoaderCircle, Save } from "lucide-react";
import { apiFetch } from "./apiClient.js";

type ShiftMetrics = {
  tapAll: number;
  tapInfluence: number;
  tapControl: number;
  szrAll: number;
  szrCompl: number;
  szrNotCompl: number;
  asbiAll: number;
  asbiP1: number;
  asbiP2: number;
  asbiDropTrafficAll: number;
  asbiDropTrafficCompl: number;
  asbiNotComplP1P2: number;
  naumenLongTt: number;
  events: number;
  politics: number;
  bz: number;
  errors: number;
};

const summarySections: { title: string; fields: { key: keyof ShiftMetrics; label: string }[] }[] = [
  { title: "1. Контроль аварийных событий по ТАП", fields: [
    { key: "tapAll", label: "Всего событий" },
    { key: "tapInfluence", label: "С влиянием на трафик" },
    { key: "tapControl", label: "Контрольные события" }
  ] },
  { title: "2. Мониторинг СЗР", fields: [
    { key: "szrAll", label: "Всего событий" },
    { key: "szrCompl", label: "Уведомления" },
    { key: "szrNotCompl", label: "Не обработано" }
  ] },
  { title: "3. Регистрация в АСБИ", fields: [
    { key: "asbiAll", label: "Всего событий" },
    { key: "asbiP1", label: "Приоритет P1" },
    { key: "asbiP2", label: "Приоритет P2" },
    { key: "asbiDropTrafficAll", label: "Падения трафика" },
    { key: "asbiDropTrafficCompl", label: "Зарегистрировано падений трафика" },
    { key: "asbiNotComplP1P2", label: "Незарегистрировано P1/P2" }
  ] },
  { title: "4. Длительные обращения Naumen", fields: [{ key: "naumenLongTt", label: "Количество обращений" }] },
  { title: "5. Важные события", fields: [{ key: "events", label: "Количество событий" }] },
  { title: "6. Политики", fields: [{ key: "politics", label: "Количество политик" }] },
  { title: "7. База знаний", fields: [{ key: "bz", label: "Количество записей" }] },
  { title: "8. Вопросы и ошибки", fields: [{ key: "errors", label: "Количество вопросов и ошибок" }] }
];

const initialMetrics: ShiftMetrics = {
  tapAll: 0, tapInfluence: 0, tapControl: 0,
  szrAll: 0, szrCompl: 0, szrNotCompl: 0,
  asbiAll: 0, asbiP1: 0, asbiP2: 0, asbiDropTrafficAll: 0, asbiDropTrafficCompl: 0, asbiNotComplP1P2: 0,
  naumenLongTt: 0, events: 0, politics: 0, bz: 0, errors: 0
};

function localDateValue() {
  const now = new Date();
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 10);
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Не удалось выполнить запрос.";
}

export default function LtpShiftReportPage({ onBack, canEdit }: { onBack: () => void; canEdit: boolean }) {
  const [date, setDate] = useState(localDateValue);
  const [shiftNumber, setShiftNumber] = useState("1");
  const [supervisor, setSupervisor] = useState("");
  const [supervisors, setSupervisors] = useState<string[]>([]);
  const [supervisorsLoading, setSupervisorsLoading] = useState(true);
  const [metrics, setMetrics] = useState<ShiftMetrics>(initialMetrics);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    void apiFetch("/api/ltp/shift-report/supervisors", { signal: controller.signal })
      .then(async (response) => {
        const data = await response.json() as { supervisors?: string[]; error?: string };
        if (!response.ok) throw new Error(data.error ?? "Не удалось загрузить старших смены.");
        const values = data.supervisors ?? [];
        setSupervisors(values);
        if (values.length === 1) setSupervisor(values[0]!);
      })
      .catch((cause: unknown) => { if (!controller.signal.aborted) setError(errorMessage(cause)); })
      .finally(() => { if (!controller.signal.aborted) setSupervisorsLoading(false); });
    return () => controller.abort();
  }, []);

  const updateMetric = (key: keyof ShiftMetrics, value: string) => {
    const parsed = value === "" ? 0 : Number(value);
    setMetrics((current) => ({ ...current, [key]: Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : current[key] }));
    setError("");
    setNotice("");
  };

  const save = async () => {
    if (!canEdit || saving) return;
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const response = await apiFetch("/api/ltp/shift-report", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ date, shiftNumber, supervisor, ...metrics })
      });
      const data = await response.json() as { saved?: boolean; error?: string };
      if (!response.ok || !data.saved) throw new Error(data.error ?? "Не удалось сохранить сводку передачи смены.");
      setNotice("Сводка передачи смены сохранена.");
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setSaving(false);
    }
  };

  return <section className="section-view ltp-shift-page">
    <div className="eyebrow"><span className="eyebrow-line" /> 1ЛТП</div>
    <div className="section-hero">
      <span className="section-hero-icon"><ClipboardList size={22} /></span>
      <div><h1>Передача смены</h1><p>Заполните параметры смены и сводные показатели по разделам.</p></div>
      <button type="button" className="text-button" onClick={onBack}><ArrowLeft size={15} /> Назад</button>
    </div>

    <div className="panel ltp-shift-panel">
      <div className="ltp-shift-panel-heading">
        <div><h2>Параметры текущей смены</h2><p>Укажите дату, номер смены и старшего смены.</p></div>
        <CalendarDays size={18} />
      </div>
      <div className="ltp-shift-meta-grid">
        <label className="field-label" htmlFor="ltp-shift-date">Дата начала смены
          <input id="ltp-shift-date" type="date" value={date} disabled={saving} onChange={(event) => { setDate(event.target.value); setError(""); setNotice(""); }} />
        </label>
        <fieldset className="ltp-shift-number-field">
          <legend className="field-label">Смена</legend>
          <div className="ltp-shift-number-options">{["1", "2", "3", "4"].map((value) => <label key={value} className={shiftNumber === value ? "is-selected" : ""}>
            <input type="radio" name="ltp-shift-number" value={value} checked={shiftNumber === value} disabled={saving} onChange={() => { setShiftNumber(value); setError(""); setNotice(""); }} />
            <span>{value}</span>
          </label>)}</div>
        </fieldset>
        <label className="field-label" htmlFor="ltp-shift-supervisor">Старший смены
          <select id="ltp-shift-supervisor" value={supervisor} disabled={saving || supervisorsLoading} onChange={(event) => { setSupervisor(event.target.value); setError(""); setNotice(""); }}>
            <option value="">{supervisorsLoading ? "Загружаем список…" : supervisors.length ? "Выберите сотрудника" : "Список не загружен"}</option>
            {supervisors.map((name) => <option value={name} key={name}>{name}</option>)}
          </select>
        </label>
      </div>
    </div>

    <section className="section-heading ltp-shift-summary-heading">
      <div><h2>Сводка за смену</h2><p>Показатели сохраняются в журнал передачи смены 1ЛТП.</p></div>
    </section>
    <div className="ltp-shift-summary-grid">
      {summarySections.map((section) => <section className="panel ltp-shift-summary-card" key={section.title}>
        <h3>{section.title}</h3>
        <div className="ltp-shift-metric-grid">
          {section.fields.map((field) => <label className="field-label" key={field.key} htmlFor={`ltp-shift-${field.key}`}>
            {field.label}
            <input id={`ltp-shift-${field.key}`} type="number" min="0" step="1" value={metrics[field.key]} disabled={saving} onChange={(event) => updateMetric(field.key, event.target.value)} />
          </label>)}
        </div>
      </section>)}
    </div>

    <div className="portal-config-note ltp-shift-note"><CalendarDays size={14} /><span>По правилам текущего журнала запись привязана к дате. Повторное сохранение за ту же дату обновит существующую строку.</span></div>
    {!canEdit && <div className="portal-config-note ltp-shift-note">Для сохранения сводки нужны права оператора.</div>}
    {error && <div className="assignment-error" role="alert">{error}</div>}
    {notice && <div className="portal-config-feedback portal-config-feedback-success" role="status"><CheckCircle2 size={15} />{notice}</div>}
    <div className="portal-config-actions ltp-shift-actions">
      <button className="btn-primary" disabled={!canEdit || saving || supervisorsLoading || !date || !supervisor} onClick={() => void save()}>
        {saving ? <LoaderCircle size={15} className="template-spinner" /> : <Save size={15} />}
        {saving ? "Сохраняем…" : "Сохранить сводку"}
      </button>
    </div>
  </section>;
}
