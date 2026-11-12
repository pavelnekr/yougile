import { useEffect, useRef, useState } from "react";
import { Activity, AlertTriangle, ArrowLeft, BellRing, BookOpen, CalendarDays, CheckCircle2, ClipboardList, Headset, LoaderCircle, Plus, RadioTower, Save, ShieldCheck, Star, Trash2, type LucideIcon } from "lucide-react";
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

type ErrorEntry = {
  id: number;
  tt: string;
  type: string;
  situation: string;
  question: string;
  solution: string;
  inBz: string;
  action: string;
  saved: boolean;
  touched: boolean;
};

let nextErrorEntryId = 1;
function createErrorEntry(): ErrorEntry {
  return { id: nextErrorEntryId++, tt: "", type: "", situation: "", question: "", solution: "", inBz: "Нет", action: "", saved: false, touched: false };
}

function isFilledErrorEntry(entry: ErrorEntry) {
  return [entry.tt, entry.type, entry.situation, entry.question, entry.solution, entry.action].some((item) => item.trim()) || (entry.saved && !entry.touched) || (entry.touched && entry.inBz === "Да");
}

const summarySections: { title: string; icon: LucideIcon; tone: string; fields: { key: keyof ShiftMetrics; label: string }[] }[] = [
  { title: "Контроль аварийных событий по ТАП", icon: RadioTower, tone: "blue", fields: [
    { key: "tapAll", label: "Всего событий" },
    { key: "tapInfluence", label: "С влиянием на трафик" },
    { key: "tapControl", label: "Контрольные события" }
  ] },
  { title: "Мониторинг СЗР", icon: BellRing, tone: "amber", fields: [
    { key: "szrAll", label: "Всего событий" },
    { key: "szrCompl", label: "Уведомления" },
    { key: "szrNotCompl", label: "Не обработано" }
  ] },
  { title: "Регистрация в АСБИ", icon: Activity, tone: "green", fields: [
    { key: "asbiAll", label: "Всего событий" },
    { key: "asbiP1", label: "Приоритет P1" },
    { key: "asbiP2", label: "Приоритет P2" },
    { key: "asbiDropTrafficAll", label: "Падения трафика" },
    { key: "asbiDropTrafficCompl", label: "Зарегистрировано падений трафика" },
    { key: "asbiNotComplP1P2", label: "Незарегистрировано P1/P2" }
  ] },
  { title: "Длительные обращения Naumen", icon: Headset, tone: "violet", fields: [{ key: "naumenLongTt", label: "Количество обращений" }] },
  { title: "Важные события", icon: Star, tone: "rose", fields: [{ key: "events", label: "Количество событий" }] },
  { title: "Политики", icon: ShieldCheck, tone: "teal", fields: [{ key: "politics", label: "Количество политик" }] },
  { title: "База знаний", icon: BookOpen, tone: "indigo", fields: [{ key: "bz", label: "Количество записей" }] },
  { title: "Вопросы и ошибки", icon: AlertTriangle, tone: "orange", fields: [{ key: "errors", label: "Количество вопросов и ошибок" }] }
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
  const [errorEntries, setErrorEntries] = useState<ErrorEntry[]>([createErrorEntry()]);
  const [saving, setSaving] = useState(false);
  const [reportLoading, setReportLoading] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const previousDate = useRef(date);
  const activeSections = summarySections.filter((section) => section.fields.some(({ key }) => metrics[key] > 0)).length;

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

  useEffect(() => {
    if (previousDate.current === date) return;
    previousDate.current = date;
    const controller = new AbortController();
    setMetrics(initialMetrics);
    setErrorEntries([createErrorEntry()]);
    setShiftNumber("1");
    setSupervisor("");
    setError("");
    setNotice("");
    if (!date || date >= localDateValue()) {
      setReportLoading(false);
      return () => controller.abort();
    }

    setReportLoading(true);
    void apiFetch(`/api/ltp/shift-report?date=${encodeURIComponent(date)}`, { signal: controller.signal })
      .then(async (response) => {
        const data = await response.json() as { found?: boolean; shiftNumber?: string; supervisor?: string; metrics?: ShiftMetrics; errorRows?: Omit<ErrorEntry, "id" | "touched" | "saved">[]; error?: string };
        if (!response.ok) throw new Error(data.error ?? "Не удалось загрузить сводку за выбранную дату.");
        if (data.found && data.metrics) {
          setMetrics({ ...initialMetrics, ...data.metrics });
          setErrorEntries(data.errorRows?.length
            ? data.errorRows.map((entry) => ({ ...createErrorEntry(), ...entry, saved: true }))
            : [createErrorEntry()]);
          setShiftNumber(["1", "2", "3", "4"].includes(data.shiftNumber ?? "") ? data.shiftNumber! : "1");
          setSupervisor(data.supervisor ?? "");
          setNotice("Загружена сохранённая сводка за эту дату.");
        } else {
          setNotice("За эту дату сохранённой сводки нет. Заполните показатели.");
        }
      })
      .catch((cause: unknown) => { if (!controller.signal.aborted) setError(errorMessage(cause)); })
      .finally(() => { if (!controller.signal.aborted) setReportLoading(false); });
    return () => controller.abort();
  }, [date]);

  const updateMetric = (key: keyof ShiftMetrics, value: string) => {
    const parsed = value === "" ? 0 : Number(value);
    setMetrics((current) => ({ ...current, [key]: Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : current[key] }));
    setError("");
    setNotice("");
  };

  const updateErrorEntry = (id: number, key: keyof Omit<ErrorEntry, "id" | "touched">, value: string) => {
    const updated = errorEntries.map((entry) => entry.id === id ? { ...entry, [key]: value, touched: true } : entry);
    setErrorEntries(updated);
    const count = updated.filter(isFilledErrorEntry).length;
    setMetrics((current) => ({ ...current, errors: count }));
    setError("");
    setNotice("");
  };

  const removeErrorEntry = (id: number) => {
    const updated = errorEntries.filter((entry) => entry.id !== id);
    const count = updated.filter(isFilledErrorEntry).length;
    setErrorEntries(updated.length ? updated : [createErrorEntry()]);
    setMetrics((current) => ({ ...current, errors: count }));
    setError("");
    setNotice("");
  };

  const addErrorEntry = () => setErrorEntries((current) => [...current, createErrorEntry()]);

  const save = async () => {
    if (!canEdit || saving) return;
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const response = await apiFetch("/api/ltp/shift-report", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          date,
          shiftNumber,
          supervisor,
          ...metrics,
          errorRows: errorEntries
            .filter(isFilledErrorEntry)
            .map(({ tt, type, situation, question, solution, inBz, action }) => ({ tt, type, situation, question, solution, inBz, action }))
        })
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

    <div className="ltp-shift-overview panel">
      <div className="ltp-shift-overview-copy">
        <span className="ltp-shift-overview-icon"><ClipboardList size={19} /></span>
        <div><strong>Показатели смены</strong><span>Сводка по восьми направлениям работы 1ЛТП</span></div>
      </div>
      <div className="ltp-shift-overview-progress" role="img" aria-label={`${activeSections} из 8 направлений содержат ненулевые показатели`}>
        <div className="ltp-shift-overview-segments">{summarySections.map((section, index) => {
          const hasData = section.fields.some(({ key }) => metrics[key] > 0);
          return <span key={section.title} className={hasData ? `is-active tone-${section.tone}` : ""} title={`${index + 1}. ${section.title}`} />;
        })}</div>
        <small><strong>{activeSections}</strong> из 8 направлений с показателями</small>
      </div>
      <div className="ltp-shift-overview-count"><strong>08</strong><span>направлений</span></div>
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
            <input type="radio" name="ltp-shift-number" value={value} checked={shiftNumber === value} disabled={saving || reportLoading} onChange={() => { setShiftNumber(value); setError(""); setNotice(""); }} />
            <span>{value}</span>
          </label>)}</div>
        </fieldset>
        <label className="field-label" htmlFor="ltp-shift-supervisor">Старший смены
          <select id="ltp-shift-supervisor" value={supervisor} disabled={saving || reportLoading || supervisorsLoading} onChange={(event) => { setSupervisor(event.target.value); setError(""); setNotice(""); }}>
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
      {summarySections.map((section, index) => {
        const SectionIcon = section.icon;
        if (section.fields[0]?.key === "errors") {
          const hasData = metrics.errors > 0;
          return <section className={`panel ltp-shift-summary-card ltp-shift-errors-card ${hasData ? "has-data" : ""}`} key={section.title}>
            <div className="ltp-shift-card-heading">
              <span className={`ltp-shift-card-icon tone-${section.tone}`}><SectionIcon size={16} /></span>
              <div className="ltp-shift-card-title"><small>НАПРАВЛЕНИЕ {String(index + 1).padStart(2, "0")}</small><h3>{section.title}</h3></div>
              <span className="ltp-shift-card-count">{metrics.errors} {metrics.errors === 1 ? "запись" : "записей"}</span>
            </div>
            <div className="ltp-shift-error-entries">
              {errorEntries.map((entry, entryIndex) => <article className="ltp-shift-error-entry" key={entry.id}>
                <div className="ltp-shift-error-entry-heading">
                  <div className="ltp-shift-error-entry-title"><span>{String(entryIndex + 1).padStart(2, "0")}</span><strong>Запись о вопросе или ошибке</strong></div>
                  <span className={`ltp-shift-error-entry-state ${isFilledErrorEntry(entry) ? "is-filled" : ""}`}>{isFilledErrorEntry(entry) ? "Заполнена" : "Черновик"}</span>
                  <button type="button" className="ltp-shift-remove-row" aria-label={`Удалить запись ${entryIndex + 1}`} disabled={saving || reportLoading} onClick={() => removeErrorEntry(entry.id)}><Trash2 size={14} /></button>
                </div>
                <div className="ltp-shift-error-entry-meta">
                  <label className="field-label">№ ТТ<input value={entry.tt} disabled={saving || reportLoading} onChange={(event) => updateErrorEntry(entry.id, "tt", event.target.value)} /></label>
                  <label className="field-label">Тип<input value={entry.type} disabled={saving || reportLoading} onChange={(event) => updateErrorEntry(entry.id, "type", event.target.value)} /></label>
                  <label className="field-label">Есть в БЗ<select value={entry.inBz} disabled={saving || reportLoading} onChange={(event) => updateErrorEntry(entry.id, "inBz", event.target.value)}><option>Да</option><option>Нет</option></select></label>
                </div>
                <div className="ltp-shift-error-entry-details">
                  <label className="field-label">Ситуация<textarea value={entry.situation} disabled={saving || reportLoading} onChange={(event) => updateErrorEntry(entry.id, "situation", event.target.value)} /></label>
                  <label className="field-label">Вопрос / ошибка<textarea value={entry.question} disabled={saving || reportLoading} onChange={(event) => updateErrorEntry(entry.id, "question", event.target.value)} /></label>
                  <label className="field-label">Правильное решение<textarea value={entry.solution} disabled={saving || reportLoading} onChange={(event) => updateErrorEntry(entry.id, "solution", event.target.value)} /></label>
                  <label className="field-label">Действие<textarea value={entry.action} disabled={saving || reportLoading} onChange={(event) => updateErrorEntry(entry.id, "action", event.target.value)} /></label>
                </div>
              </article>)}
            </div>
            <div className="ltp-shift-errors-footer">
              <button type="button" className="ltp-shift-add-row" disabled={saving || reportLoading} onClick={addErrorEntry}><Plus size={14} /> Добавить запись</button>
              <span>Заполненные строки сохраняются в ltp_1.errors и привязываются к выбранной дате.</span>
            </div>
          </section>;
        }
        const singleField = section.fields.length === 1;
        const hasData = section.fields.some(({ key }) => metrics[key] > 0);
        return <section className={`panel ltp-shift-summary-card ${singleField ? "is-single-metric" : ""} ${hasData ? "has-data" : ""}`} key={section.title}>
        <div className="ltp-shift-card-heading">
          <span className={`ltp-shift-card-icon tone-${section.tone}`}><SectionIcon size={16} /></span>
          <div className="ltp-shift-card-title"><small>НАПРАВЛЕНИЕ {String(index + 1).padStart(2, "0")}</small><h3>{section.title}</h3></div>
          <span className="ltp-shift-card-count">{section.fields.length} {section.fields.length === 1 ? "показатель" : section.fields.length < 5 ? "показателя" : "показателей"}</span>
        </div>
        <div className="ltp-shift-metric-grid">
          {section.fields.map((field) => <label className="field-label" key={field.key} htmlFor={`ltp-shift-${field.key}`}>
            {field.label}
            <input id={`ltp-shift-${field.key}`} type="number" min="0" step="1" value={metrics[field.key]} disabled={saving || reportLoading} onChange={(event) => updateMetric(field.key, event.target.value)} />
          </label>)}
        </div>
      </section>;
      })}
    </div>

    <div className="portal-config-note ltp-shift-note"><CalendarDays size={14} /><span>По правилам текущего журнала запись привязана к дате. Повторное сохранение за ту же дату обновит существующую строку.</span></div>
    {reportLoading && <div className="portal-config-note ltp-shift-note" role="status"><LoaderCircle size={14} className="template-spinner" /> Загружаем сводку за выбранную дату…</div>}
    {!canEdit && <div className="portal-config-note ltp-shift-note">Для сохранения сводки нужны права оператора.</div>}
    {error && <div className="assignment-error" role="alert">{error}</div>}
    {notice && <div className="portal-config-feedback portal-config-feedback-success" role="status"><CheckCircle2 size={15} />{notice}</div>}
    <div className="portal-config-actions ltp-shift-actions">
      <button className="btn-primary" disabled={!canEdit || saving || reportLoading || supervisorsLoading || !date || !supervisor} onClick={() => void save()}>
        {saving || reportLoading ? <LoaderCircle size={15} className="template-spinner" /> : <Save size={15} />}
        {saving ? "Сохраняем…" : reportLoading ? "Загружаем…" : "Сохранить сводку"}
      </button>
    </div>
  </section>;
}
