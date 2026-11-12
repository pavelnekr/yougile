import { useEffect, useState } from "react";
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

type TapEntry = {
  id: number;
  eventDate: string;
  area: string;
  device: string;
  alert: string;
  tt: string;
  control: string;
  actions: string;
};

type SzrEntry = {
  id: number;
  alertTime: string;
  resource: string;
  notifyTime: string;
  notification: string;
  managementCall: string;
  processTime: string;
  reason: string;
};

type AsbiEntry = {
  id: number;
  tt: string;
  priority: string;
  description: string;
  status: string;
  responsibleUnit: string;
};

type NaumenEntry = {
  id: number;
  tt: string;
  responsible: string;
  timeInWork: string;
  reason: string;
  lastAction: string;
  nextAction: string;
};

type ImportantEventEntry = {
  id: number;
  eventTime: string;
  eventName: string;
  whatHappened: string;
  todoControl: string;
  deadline: string;
  ttLink: string;
};

type PoliticsEntry = {
  id: number;
  time: string;
  scope: string;
  policy: string;
  basis: string;
  control: string;
};

type BzEntry = {
  id: number;
  section: string;
  changeType: string;
  whatChanged: string;
  attention: string;
};

let nextErrorEntryId = 1;
function createErrorEntry(): ErrorEntry {
  return { id: nextErrorEntryId++, tt: "", type: "", situation: "", question: "", solution: "", inBz: "Нет", action: "", saved: false, touched: false };
}

function isFilledErrorEntry(entry: ErrorEntry) {
  return [entry.tt, entry.type, entry.situation, entry.question, entry.solution, entry.action].some((item) => item.trim()) || (entry.saved && !entry.touched) || (entry.touched && entry.inBz === "Да");
}

let nextTapEntryId = 1;
function createTapEntry(): TapEntry {
  return { id: nextTapEntryId++, eventDate: "", area: "", device: "", alert: "", tt: "", control: "", actions: "" };
}

function isFilledTapEntry(entry: TapEntry) {
  return [entry.eventDate, entry.area, entry.device, entry.alert, entry.tt, entry.control, entry.actions].some((item) => item.trim());
}

let nextSzrEntryId = 1;
function createSzrEntry(): SzrEntry {
  return { id: nextSzrEntryId++, alertTime: "", resource: "", notifyTime: "", notification: "Да", managementCall: "Да", processTime: "", reason: "" };
}

function isFilledSzrEntry(entry: SzrEntry) {
  return [entry.alertTime, entry.resource, entry.notifyTime, entry.processTime, entry.reason].some((item) => item.trim()) || entry.notification === "Нет" || entry.managementCall === "Нет";
}

let nextAsbiEntryId = 1;
function createAsbiEntry(): AsbiEntry {
  return { id: nextAsbiEntryId++, tt: "", priority: "", description: "", status: "", responsibleUnit: "" };
}

function isFilledAsbiEntry(entry: AsbiEntry) {
  return [entry.tt, entry.priority, entry.description, entry.status, entry.responsibleUnit].some((item) => item.trim());
}

let nextNaumenEntryId = 1;
function createNaumenEntry(): NaumenEntry {
  return { id: nextNaumenEntryId++, tt: "", responsible: "", timeInWork: "", reason: "", lastAction: "", nextAction: "" };
}

function isFilledNaumenEntry(entry: NaumenEntry) {
  return [entry.tt, entry.responsible, entry.timeInWork, entry.reason, entry.lastAction, entry.nextAction].some((item) => item.trim());
}

let nextImportantEventId = 1;
function createImportantEvent(): ImportantEventEntry {
  return { id: nextImportantEventId++, eventTime: "", eventName: "", whatHappened: "", todoControl: "", deadline: "", ttLink: "" };
}

function isFilledImportantEvent(entry: ImportantEventEntry) {
  return [entry.eventTime, entry.eventName, entry.whatHappened, entry.todoControl, entry.deadline, entry.ttLink].some((item) => item.trim());
}

let nextPoliticsEntryId = 1;
function createPoliticsEntry(): PoliticsEntry {
  return { id: nextPoliticsEntryId++, time: "", scope: "", policy: "", basis: "", control: "Да" };
}

function isFilledPoliticsEntry(entry: PoliticsEntry) {
  return [entry.time, entry.scope, entry.policy, entry.basis].some((item) => item.trim()) || entry.control === "Нет";
}

let nextBzEntryId = 1;
function createBzEntry(): BzEntry {
  return { id: nextBzEntryId++, section: "", changeType: "Новая", whatChanged: "", attention: "" };
}

function isFilledBzEntry(entry: BzEntry) {
  return [entry.section, entry.whatChanged, entry.attention].some((item) => item.trim()) || entry.changeType !== "Новая";
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
  const [tapEntries, setTapEntries] = useState<TapEntry[]>([createTapEntry()]);
  const [szrEntries, setSzrEntries] = useState<SzrEntry[]>([createSzrEntry()]);
  const [asbiEntries, setAsbiEntries] = useState<AsbiEntry[]>([createAsbiEntry()]);
  const [naumenEntries, setNaumenEntries] = useState<NaumenEntry[]>([createNaumenEntry()]);
  const [importantEvents, setImportantEvents] = useState<ImportantEventEntry[]>([createImportantEvent()]);
  const [politicsEntries, setPoliticsEntries] = useState<PoliticsEntry[]>([createPoliticsEntry()]);
  const [bzEntries, setBzEntries] = useState<BzEntry[]>([createBzEntry()]);
  const [saving, setSaving] = useState(false);
  const [reportLoading, setReportLoading] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const activeSections = summarySections.filter((section) => section.fields.some(({ key }) => metrics[key] > 0)
    || section.fields[0]?.key === "tapAll" && tapEntries.some(isFilledTapEntry)
    || section.fields[0]?.key === "szrAll" && szrEntries.some(isFilledSzrEntry)
    || section.fields[0]?.key === "asbiAll" && asbiEntries.some(isFilledAsbiEntry)
    || section.fields[0]?.key === "naumenLongTt" && naumenEntries.some(isFilledNaumenEntry)
    || section.fields[0]?.key === "events" && importantEvents.some(isFilledImportantEvent)
    || section.fields[0]?.key === "politics" && politicsEntries.some(isFilledPoliticsEntry)
    || section.fields[0]?.key === "bz" && bzEntries.some(isFilledBzEntry)).length;

  useEffect(() => {
    const controller = new AbortController();
    void apiFetch("/api/ltp/shift-report/supervisors", { signal: controller.signal })
      .then(async (response) => {
        const data = await response.json() as { supervisors?: string[]; error?: string };
        if (!response.ok) throw new Error(data.error ?? "Не удалось загрузить старших смены.");
        const values = data.supervisors ?? [];
        setSupervisors(values);
        if (values.length === 1) setSupervisor((current) => current || values[0]!);
      })
      .catch((cause: unknown) => { if (!controller.signal.aborted) setError(errorMessage(cause)); })
      .finally(() => { if (!controller.signal.aborted) setSupervisorsLoading(false); });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    setMetrics(initialMetrics);
    setErrorEntries([createErrorEntry()]);
    setTapEntries([createTapEntry()]);
    setSzrEntries([createSzrEntry()]);
    setAsbiEntries([createAsbiEntry()]);
    setNaumenEntries([createNaumenEntry()]);
    setImportantEvents([createImportantEvent()]);
    setPoliticsEntries([createPoliticsEntry()]);
    setBzEntries([createBzEntry()]);
    setShiftNumber("1");
    setSupervisor("");
    setError("");
    setNotice("");
    if (!date) {
      setReportLoading(false);
      return () => controller.abort();
    }

    setReportLoading(true);
    void apiFetch(`/api/ltp/shift-report?date=${encodeURIComponent(date)}`, { signal: controller.signal })
      .then(async (response) => {
        const data = await response.json() as { found?: boolean; shiftNumber?: string; supervisor?: string; metrics?: ShiftMetrics; errorRows?: Omit<ErrorEntry, "id" | "touched" | "saved">[]; tapRows?: Omit<TapEntry, "id">[]; szrRows?: Omit<SzrEntry, "id">[]; asbiRows?: Omit<AsbiEntry, "id">[]; naumenRows?: Omit<NaumenEntry, "id">[]; importantEventRows?: Omit<ImportantEventEntry, "id">[]; politicsRows?: Omit<PoliticsEntry, "id">[]; bzRows?: Omit<BzEntry, "id">[]; error?: string };
        if (!response.ok) throw new Error(data.error ?? "Не удалось загрузить сводку за выбранную дату.");
        if (data.found && data.metrics) {
          setMetrics({
            ...initialMetrics,
            ...data.metrics,
            tapAll: data.tapRows?.length || data.metrics.tapAll,
            szrAll: data.szrRows?.length || data.metrics.szrAll,
            asbiAll: data.asbiRows?.length || data.metrics.asbiAll,
            naumenLongTt: data.naumenRows?.length || data.metrics.naumenLongTt,
            events: data.importantEventRows?.length || data.metrics.events,
            politics: data.politicsRows?.length || data.metrics.politics,
            bz: data.bzRows?.length || data.metrics.bz
          });
          setErrorEntries(data.errorRows?.length
            ? data.errorRows.map((entry) => ({ ...createErrorEntry(), ...entry, saved: true }))
            : [createErrorEntry()]);
          setTapEntries(data.tapRows?.length
            ? data.tapRows.map((entry) => ({ ...createTapEntry(), ...entry }))
            : [createTapEntry()]);
          setSzrEntries(data.szrRows?.length
            ? data.szrRows.map((entry) => ({ ...createSzrEntry(), ...entry }))
            : [createSzrEntry()]);
          setAsbiEntries(data.asbiRows?.length
            ? data.asbiRows.map((entry) => ({ ...createAsbiEntry(), ...entry }))
            : [createAsbiEntry()]);
          setNaumenEntries(data.naumenRows?.length
            ? data.naumenRows.map((entry) => ({ ...createNaumenEntry(), ...entry }))
            : [createNaumenEntry()]);
          setImportantEvents(data.importantEventRows?.length
            ? data.importantEventRows.map((entry) => ({ ...createImportantEvent(), ...entry }))
            : [createImportantEvent()]);
          setPoliticsEntries(data.politicsRows?.length
            ? data.politicsRows.map((entry) => ({ ...createPoliticsEntry(), ...entry }))
            : [createPoliticsEntry()]);
          setBzEntries(data.bzRows?.length
            ? data.bzRows.map((entry) => ({ ...createBzEntry(), ...entry }))
            : [createBzEntry()]);
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

  const updateTapEntry = (id: number, key: keyof Omit<TapEntry, "id">, value: string) => {
    const updated = tapEntries.map((entry) => entry.id === id ? { ...entry, [key]: value } : entry);
    setTapEntries(updated);
    setMetrics((current) => ({ ...current, tapAll: updated.filter(isFilledTapEntry).length }));
    setError("");
    setNotice("");
  };

  const removeTapEntry = (id: number) => {
    const updated = tapEntries.filter((entry) => entry.id !== id);
    setTapEntries(updated.length ? updated : [createTapEntry()]);
    setMetrics((current) => ({ ...current, tapAll: updated.filter(isFilledTapEntry).length }));
    setError("");
    setNotice("");
  };

  const addTapEntry = () => setTapEntries((current) => [...current, createTapEntry()]);

  const updateSzrEntry = (id: number, key: keyof Omit<SzrEntry, "id">, value: string) => {
    const updated = szrEntries.map((entry) => entry.id === id ? { ...entry, [key]: value } : entry);
    setSzrEntries(updated);
    setMetrics((current) => ({ ...current, szrAll: updated.filter(isFilledSzrEntry).length }));
    setError("");
    setNotice("");
  };

  const removeSzrEntry = (id: number) => {
    const updated = szrEntries.filter((entry) => entry.id !== id);
    setSzrEntries(updated.length ? updated : [createSzrEntry()]);
    setMetrics((current) => ({ ...current, szrAll: updated.filter(isFilledSzrEntry).length }));
    setError("");
    setNotice("");
  };

  const addSzrEntry = () => setSzrEntries((current) => [...current, createSzrEntry()]);

  const updateAsbiEntry = (id: number, key: keyof Omit<AsbiEntry, "id">, value: string) => {
    const updated = asbiEntries.map((entry) => entry.id === id ? { ...entry, [key]: value } : entry);
    setAsbiEntries(updated);
    setMetrics((current) => ({ ...current, asbiAll: updated.filter(isFilledAsbiEntry).length }));
    setError("");
    setNotice("");
  };

  const removeAsbiEntry = (id: number) => {
    const updated = asbiEntries.filter((entry) => entry.id !== id);
    setAsbiEntries(updated.length ? updated : [createAsbiEntry()]);
    setMetrics((current) => ({ ...current, asbiAll: updated.filter(isFilledAsbiEntry).length }));
    setError("");
    setNotice("");
  };

  const addAsbiEntry = () => setAsbiEntries((current) => [...current, createAsbiEntry()]);

  const updateNaumenEntry = (id: number, key: keyof Omit<NaumenEntry, "id">, value: string) => {
    const updated = naumenEntries.map((entry) => entry.id === id ? { ...entry, [key]: value } : entry);
    setNaumenEntries(updated);
    setMetrics((current) => ({ ...current, naumenLongTt: updated.filter(isFilledNaumenEntry).length }));
    setError("");
    setNotice("");
  };

  const removeNaumenEntry = (id: number) => {
    const updated = naumenEntries.filter((entry) => entry.id !== id);
    setNaumenEntries(updated.length ? updated : [createNaumenEntry()]);
    setMetrics((current) => ({ ...current, naumenLongTt: updated.filter(isFilledNaumenEntry).length }));
    setError("");
    setNotice("");
  };

  const addNaumenEntry = () => setNaumenEntries((current) => [...current, createNaumenEntry()]);

  const updateImportantEvent = (id: number, key: keyof Omit<ImportantEventEntry, "id">, value: string) => {
    const updated = importantEvents.map((event) => event.id === id ? { ...event, [key]: value } : event);
    setImportantEvents(updated);
    setMetrics((current) => ({ ...current, events: updated.filter(isFilledImportantEvent).length }));
    setError("");
    setNotice("");
  };

  const removeImportantEvent = (id: number) => {
    const updated = importantEvents.filter((event) => event.id !== id);
    setImportantEvents(updated.length ? updated : [createImportantEvent()]);
    setMetrics((current) => ({ ...current, events: updated.filter(isFilledImportantEvent).length }));
    setError("");
    setNotice("");
  };

  const addImportantEvent = () => setImportantEvents((current) => [...current, createImportantEvent()]);

  const updatePoliticsEntry = (id: number, key: keyof Omit<PoliticsEntry, "id">, value: string) => {
    const updated = politicsEntries.map((entry) => entry.id === id ? { ...entry, [key]: value } : entry);
    setPoliticsEntries(updated);
    setMetrics((current) => ({ ...current, politics: updated.filter(isFilledPoliticsEntry).length }));
    setError("");
    setNotice("");
  };

  const removePoliticsEntry = (id: number) => {
    const updated = politicsEntries.filter((entry) => entry.id !== id);
    setPoliticsEntries(updated.length ? updated : [createPoliticsEntry()]);
    setMetrics((current) => ({ ...current, politics: updated.filter(isFilledPoliticsEntry).length }));
    setError("");
    setNotice("");
  };

  const addPoliticsEntry = () => setPoliticsEntries((current) => [...current, createPoliticsEntry()]);

  const updateBzEntry = (id: number, key: keyof Omit<BzEntry, "id">, value: string) => {
    const updated = bzEntries.map((entry) => entry.id === id ? { ...entry, [key]: value } : entry);
    setBzEntries(updated);
    setMetrics((current) => ({ ...current, bz: updated.filter(isFilledBzEntry).length }));
    setError("");
    setNotice("");
  };

  const removeBzEntry = (id: number) => {
    const updated = bzEntries.filter((entry) => entry.id !== id);
    setBzEntries(updated.length ? updated : [createBzEntry()]);
    setMetrics((current) => ({ ...current, bz: updated.filter(isFilledBzEntry).length }));
    setError("");
    setNotice("");
  };

  const addBzEntry = () => setBzEntries((current) => [...current, createBzEntry()]);

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
            .map(({ tt, type, situation, question, solution, inBz, action }) => ({ tt, type, situation, question, solution, inBz, action })),
          tapRows: tapEntries.filter(isFilledTapEntry).map(({ eventDate, area, device, alert, tt, control, actions }) => ({ eventDate, area, device, alert, tt, control, actions })),
          szrRows: szrEntries.filter(isFilledSzrEntry).map(({ alertTime, resource, notifyTime, notification, managementCall, processTime, reason }) => ({ alertTime, resource, notifyTime, notification, managementCall, processTime, reason })),
          asbiRows: asbiEntries.filter(isFilledAsbiEntry).map(({ tt, priority, description, status, responsibleUnit }) => ({ tt, priority, description, status, responsibleUnit })),
          naumenRows: naumenEntries.filter(isFilledNaumenEntry).map(({ tt, responsible, timeInWork, reason, lastAction, nextAction }) => ({ tt, responsible, timeInWork, reason, lastAction, nextAction })),
          importantEventRows: importantEvents.filter(isFilledImportantEvent).map(({ eventTime, eventName, whatHappened, todoControl, deadline, ttLink }) => ({ eventTime, eventName, whatHappened, todoControl, deadline, ttLink })),
          politicsRows: politicsEntries.filter(isFilledPoliticsEntry).map(({ time, scope, policy, basis, control }) => ({ time, scope, policy, basis, control })),
          bzRows: bzEntries.filter(isFilledBzEntry).map(({ section, changeType, whatChanged, attention }) => ({ section, changeType, whatChanged, attention }))
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
        if (section.fields[0]?.key === "politics") {
          const filledPoliticsEntries = politicsEntries.filter(isFilledPoliticsEntry).length;
          const hasData = filledPoliticsEntries > 0 || metrics.politics > 0;
          return <section className={`panel ltp-shift-summary-card ltp-shift-politics-card ${hasData ? "has-data" : ""}`} key={section.title}>
            <div className="ltp-shift-card-heading">
              <span className={`ltp-shift-card-icon tone-${section.tone}`}><SectionIcon size={16} /></span>
              <div className="ltp-shift-card-title"><small>НАПРАВЛЕНИЕ {String(index + 1).padStart(2, "0")}</small><h3>{section.title}</h3></div>
              <span className="ltp-shift-card-count">{filledPoliticsEntries} записей</span>
            </div>
            <div className="ltp-shift-tap-summary ltp-shift-naumen-summary">
              {section.fields.map((field) => <label className="field-label" key={field.key} htmlFor={`ltp-shift-${field.key}`}>
                {field.label}
                <input id={`ltp-shift-${field.key}`} type="number" min="0" step="1" value={metrics[field.key]} disabled />
              </label>)}
            </div>
            <div className="ltp-shift-error-entries">
              {politicsEntries.map((entry, entryIndex) => <article className="ltp-shift-error-entry ltp-shift-politics-entry" key={entry.id}>
                <div className="ltp-shift-error-entry-heading">
                  <div className="ltp-shift-error-entry-title"><span>{String(entryIndex + 1).padStart(2, "0")}</span><strong>Политика</strong></div>
                  <span className={`ltp-shift-error-entry-state ${isFilledPoliticsEntry(entry) ? "is-filled" : ""}`}>{isFilledPoliticsEntry(entry) ? "Заполнена" : "Черновик"}</span>
                  <button type="button" className="ltp-shift-remove-row" aria-label={`Удалить запись ${entryIndex + 1}`} disabled={saving || reportLoading} onClick={() => removePoliticsEntry(entry.id)}><Trash2 size={14} /></button>
                </div>
                <div className="ltp-shift-error-entry-meta ltp-shift-politics-entry-meta">
                  <label className="field-label">Время<input type="time" value={entry.time} disabled={saving || reportLoading} onChange={(change) => updatePoliticsEntry(entry.id, "time", change.target.value)} /></label>
                  <label className="field-label">Область<input value={entry.scope} disabled={saving || reportLoading} onChange={(change) => updatePoliticsEntry(entry.id, "scope", change.target.value)} /></label>
                  <label className="field-label">Контроль<select value={entry.control} disabled={saving || reportLoading} onChange={(change) => updatePoliticsEntry(entry.id, "control", change.target.value)}><option>Да</option><option>Нет</option></select></label>
                </div>
                <div className="ltp-shift-error-entry-details ltp-shift-politics-entry-details">
                  <label className="field-label">Политика<textarea value={entry.policy} disabled={saving || reportLoading} onChange={(change) => updatePoliticsEntry(entry.id, "policy", change.target.value)} /></label>
                  <label className="field-label">Основание<textarea value={entry.basis} disabled={saving || reportLoading} onChange={(change) => updatePoliticsEntry(entry.id, "basis", change.target.value)} /></label>
                </div>
              </article>)}
            </div>
            <div className="ltp-shift-errors-footer">
              <button type="button" className="ltp-shift-add-row" disabled={saving || reportLoading} onClick={addPoliticsEntry}><Plus size={14} /> Добавить политику</button>
              <span>Записи сохраняются в ltp_1.politics_6 и привязываются к выбранной дате смены.</span>
            </div>
          </section>;
        }
        if (section.fields[0]?.key === "bz") {
          const filledBzEntries = bzEntries.filter(isFilledBzEntry).length;
          const hasData = filledBzEntries > 0 || metrics.bz > 0;
          return <section className={`panel ltp-shift-summary-card ltp-shift-bz-card ${hasData ? "has-data" : ""}`} key={section.title}>
            <div className="ltp-shift-card-heading">
              <span className={`ltp-shift-card-icon tone-${section.tone}`}><SectionIcon size={16} /></span>
              <div className="ltp-shift-card-title"><small>НАПРАВЛЕНИЕ {String(index + 1).padStart(2, "0")}</small><h3>{section.title}</h3></div>
              <span className="ltp-shift-card-count">{filledBzEntries} записей</span>
            </div>
            <div className="ltp-shift-tap-summary ltp-shift-naumen-summary">
              {section.fields.map((field) => <label className="field-label" key={field.key} htmlFor={`ltp-shift-${field.key}`}>
                {field.label}
                <input id={`ltp-shift-${field.key}`} type="number" min="0" step="1" value={metrics[field.key]} disabled />
              </label>)}
            </div>
            <div className="ltp-shift-error-entries">
              {bzEntries.map((entry, entryIndex) => <article className="ltp-shift-error-entry ltp-shift-bz-entry" key={entry.id}>
                <div className="ltp-shift-error-entry-heading">
                  <div className="ltp-shift-error-entry-title"><span>{String(entryIndex + 1).padStart(2, "0")}</span><strong>Изменение базы знаний</strong></div>
                  <span className={`ltp-shift-error-entry-state ${isFilledBzEntry(entry) ? "is-filled" : ""}`}>{isFilledBzEntry(entry) ? "Заполнено" : "Черновик"}</span>
                  <button type="button" className="ltp-shift-remove-row" aria-label={`Удалить запись ${entryIndex + 1}`} disabled={saving || reportLoading} onClick={() => removeBzEntry(entry.id)}><Trash2 size={14} /></button>
                </div>
                <div className="ltp-shift-error-entry-meta ltp-shift-bz-entry-meta">
                  <label className="field-label">Статья / раздел<input value={entry.section} disabled={saving || reportLoading} onChange={(event) => updateBzEntry(entry.id, "section", event.target.value)} /></label>
                  <label className="field-label">Тип изменения<select value={entry.changeType} disabled={saving || reportLoading} onChange={(event) => updateBzEntry(entry.id, "changeType", event.target.value)}><option>Новая</option><option>Изменение</option><option>Дополнение</option><option>Исправление</option></select></label>
                </div>
                <div className="ltp-shift-error-entry-details ltp-shift-bz-entry-details">
                  <label className="field-label">Что изменилось<textarea value={entry.whatChanged} disabled={saving || reportLoading} onChange={(event) => updateBzEntry(entry.id, "whatChanged", event.target.value)} /></label>
                  <label className="field-label">На что обратить внимание<textarea value={entry.attention} disabled={saving || reportLoading} onChange={(event) => updateBzEntry(entry.id, "attention", event.target.value)} /></label>
                </div>
              </article>)}
            </div>
            <div className="ltp-shift-errors-footer">
              <button type="button" className="ltp-shift-add-row" disabled={saving || reportLoading} onClick={addBzEntry}><Plus size={14} /> Добавить запись</button>
              <span>Записи сохраняются в ltp_1.bz_7 и привязываются к выбранной дате смены.</span>
            </div>
          </section>;
        }
        if (section.fields[0]?.key === "events") {
          const filledImportantEvents = importantEvents.filter(isFilledImportantEvent).length;
          const hasData = filledImportantEvents > 0 || metrics.events > 0;
          return <section className={`panel ltp-shift-summary-card ltp-shift-important-events-card ${hasData ? "has-data" : ""}`} key={section.title}>
            <div className="ltp-shift-card-heading">
              <span className={`ltp-shift-card-icon tone-${section.tone}`}><SectionIcon size={16} /></span>
              <div className="ltp-shift-card-title"><small>НАПРАВЛЕНИЕ {String(index + 1).padStart(2, "0")}</small><h3>{section.title}</h3></div>
              <span className="ltp-shift-card-count">{filledImportantEvents} событий</span>
            </div>
            <div className="ltp-shift-tap-summary ltp-shift-naumen-summary">
              {section.fields.map((field) => <label className="field-label" key={field.key} htmlFor={`ltp-shift-${field.key}`}>
                {field.label}
                <input id={`ltp-shift-${field.key}`} type="number" min="0" step="1" value={metrics[field.key]} disabled />
              </label>)}
            </div>
            <div className="ltp-shift-error-entries">
              {importantEvents.map((event, eventIndex) => <article className="ltp-shift-error-entry ltp-shift-important-event" key={event.id}>
                <div className="ltp-shift-error-entry-heading">
                  <div className="ltp-shift-error-entry-title"><span>{String(eventIndex + 1).padStart(2, "0")}</span><strong>Важное событие</strong></div>
                  <span className={`ltp-shift-error-entry-state ${isFilledImportantEvent(event) ? "is-filled" : ""}`}>{isFilledImportantEvent(event) ? "Заполнено" : "Черновик"}</span>
                  <button type="button" className="ltp-shift-remove-row" aria-label={`Удалить событие ${eventIndex + 1}`} disabled={saving || reportLoading} onClick={() => removeImportantEvent(event.id)}><Trash2 size={14} /></button>
                </div>
                <div className="ltp-shift-error-entry-meta ltp-shift-important-event-meta">
                  <label className="field-label">Время<input value={event.eventTime} disabled={saving || reportLoading} onChange={(change) => updateImportantEvent(event.id, "eventTime", change.target.value)} /></label>
                  <label className="field-label">Событие<input value={event.eventName} disabled={saving || reportLoading} onChange={(change) => updateImportantEvent(event.id, "eventName", change.target.value)} /></label>
                  <label className="field-label">Когда / до какого времени<input value={event.deadline} disabled={saving || reportLoading} onChange={(change) => updateImportantEvent(event.id, "deadline", change.target.value)} /></label>
                  <label className="field-label">№ ТТ / ссылка<input value={event.ttLink} disabled={saving || reportLoading} onChange={(change) => updateImportantEvent(event.id, "ttLink", change.target.value)} /></label>
                </div>
                <div className="ltp-shift-error-entry-details ltp-shift-important-event-details">
                  <label className="field-label">Что произошло<textarea value={event.whatHappened} disabled={saving || reportLoading} onChange={(change) => updateImportantEvent(event.id, "whatHappened", change.target.value)} /></label>
                  <label className="field-label">Что требуется<textarea value={event.todoControl} disabled={saving || reportLoading} onChange={(change) => updateImportantEvent(event.id, "todoControl", change.target.value)} /></label>
                </div>
              </article>)}
            </div>
            <div className="ltp-shift-errors-footer">
              <button type="button" className="ltp-shift-add-row" disabled={saving || reportLoading} onClick={addImportantEvent}><Plus size={14} /> Добавить событие</button>
              <span>События сохраняются в ltp_1.events_5 и привязываются к выбранной дате смены.</span>
            </div>
          </section>;
        }
        if (section.fields[0]?.key === "naumenLongTt") {
          const filledNaumenEntries = naumenEntries.filter(isFilledNaumenEntry).length;
          const hasData = filledNaumenEntries > 0 || metrics.naumenLongTt > 0;
          return <section className={`panel ltp-shift-summary-card ltp-shift-naumen-card ${hasData ? "has-data" : ""}`} key={section.title}>
            <div className="ltp-shift-card-heading">
              <span className={`ltp-shift-card-icon tone-${section.tone}`}><SectionIcon size={16} /></span>
              <div className="ltp-shift-card-title"><small>НАПРАВЛЕНИЕ {String(index + 1).padStart(2, "0")}</small><h3>{section.title}</h3></div>
              <span className="ltp-shift-card-count">{filledNaumenEntries} {filledNaumenEntries === 1 ? "обращение" : "обращений"}</span>
            </div>
            <div className="ltp-shift-tap-summary ltp-shift-naumen-summary">
              {section.fields.map((field) => <label className="field-label" key={field.key} htmlFor={`ltp-shift-${field.key}`}>
                {field.label}
                <input id={`ltp-shift-${field.key}`} type="number" min="0" step="1" value={metrics[field.key]} disabled />
              </label>)}
            </div>
            <div className="ltp-shift-error-entries">
              {naumenEntries.map((entry, entryIndex) => <article className="ltp-shift-error-entry ltp-shift-naumen-entry" key={entry.id}>
                <div className="ltp-shift-error-entry-heading">
                  <div className="ltp-shift-error-entry-title"><span>{String(entryIndex + 1).padStart(2, "0")}</span><strong>Длительное обращение</strong></div>
                  <span className={`ltp-shift-error-entry-state ${isFilledNaumenEntry(entry) ? "is-filled" : ""}`}>{isFilledNaumenEntry(entry) ? "Заполнено" : "Черновик"}</span>
                  <button type="button" className="ltp-shift-remove-row" aria-label={`Удалить обращение ${entryIndex + 1}`} disabled={saving || reportLoading} onClick={() => removeNaumenEntry(entry.id)}><Trash2 size={14} /></button>
                </div>
                <div className="ltp-shift-error-entry-meta ltp-shift-naumen-entry-meta">
                  <label className="field-label">№ ТТ<input value={entry.tt} disabled={saving || reportLoading} onChange={(event) => updateNaumenEntry(entry.id, "tt", event.target.value)} /></label>
                  <label className="field-label">Ответственный<input value={entry.responsible} disabled={saving || reportLoading} onChange={(event) => updateNaumenEntry(entry.id, "responsible", event.target.value)} /></label>
                  <label className="field-label">Время в работе<input value={entry.timeInWork} disabled={saving || reportLoading} onChange={(event) => updateNaumenEntry(entry.id, "timeInWork", event.target.value)} /></label>
                </div>
                <div className="ltp-shift-error-entry-details ltp-shift-naumen-entry-details">
                  <label className="field-label">Причина<textarea value={entry.reason} disabled={saving || reportLoading} onChange={(event) => updateNaumenEntry(entry.id, "reason", event.target.value)} /></label>
                  <label className="field-label">Последнее действие<textarea value={entry.lastAction} disabled={saving || reportLoading} onChange={(event) => updateNaumenEntry(entry.id, "lastAction", event.target.value)} /></label>
                  <label className="field-label">Следующее действие<textarea value={entry.nextAction} disabled={saving || reportLoading} onChange={(event) => updateNaumenEntry(entry.id, "nextAction", event.target.value)} /></label>
                </div>
              </article>)}
            </div>
            <div className="ltp-shift-errors-footer">
              <button type="button" className="ltp-shift-add-row" disabled={saving || reportLoading} onClick={addNaumenEntry}><Plus size={14} /> Добавить обращение</button>
              <span>Обращения сохраняются в ltp_1.naumen_4 и привязываются к выбранной дате смены.</span>
            </div>
          </section>;
        }
        if (section.fields[0]?.key === "asbiAll") {
          const filledAsbiEntries = asbiEntries.filter(isFilledAsbiEntry).length;
          const hasData = filledAsbiEntries > 0 || section.fields.some(({ key }) => metrics[key] > 0);
          return <section className={`panel ltp-shift-summary-card ltp-shift-asbi-card ${hasData ? "has-data" : ""}`} key={section.title}>
            <div className="ltp-shift-card-heading">
              <span className={`ltp-shift-card-icon tone-${section.tone}`}><SectionIcon size={16} /></span>
              <div className="ltp-shift-card-title"><small>НАПРАВЛЕНИЕ {String(index + 1).padStart(2, "0")}</small><h3>{section.title}</h3></div>
              <span className="ltp-shift-card-count">{filledAsbiEntries} записей</span>
            </div>
            <div className="ltp-shift-tap-summary">
              {section.fields.map((field) => <label className="field-label" key={field.key} htmlFor={`ltp-shift-${field.key}`}>
                {field.label}
                <input id={`ltp-shift-${field.key}`} type="number" min="0" step="1" value={metrics[field.key]} disabled={saving || reportLoading || field.key === "asbiAll"} onChange={(event) => updateMetric(field.key, event.target.value)} />
              </label>)}
            </div>
            <div className="ltp-shift-error-entries">
              {asbiEntries.map((entry, entryIndex) => <article className="ltp-shift-error-entry ltp-shift-asbi-entry" key={entry.id}>
                <div className="ltp-shift-error-entry-heading">
                  <div className="ltp-shift-error-entry-title"><span>{String(entryIndex + 1).padStart(2, "0")}</span><strong>Незакрытая ТТ P1–P2</strong></div>
                  <span className={`ltp-shift-error-entry-state ${isFilledAsbiEntry(entry) ? "is-filled" : ""}`}>{isFilledAsbiEntry(entry) ? "Заполнена" : "Черновик"}</span>
                  <button type="button" className="ltp-shift-remove-row" aria-label={`Удалить ТТ ${entryIndex + 1}`} disabled={saving || reportLoading} onClick={() => removeAsbiEntry(entry.id)}><Trash2 size={14} /></button>
                </div>
                <div className="ltp-shift-error-entry-meta ltp-shift-asbi-entry-meta">
                  <label className="field-label">№ ТТ<input value={entry.tt} disabled={saving || reportLoading} onChange={(event) => updateAsbiEntry(entry.id, "tt", event.target.value)} /></label>
                  <label className="field-label">Приоритет<input value={entry.priority} disabled={saving || reportLoading} onChange={(event) => updateAsbiEntry(entry.id, "priority", event.target.value)} /></label>
                  <label className="field-label">Текущий статус<input value={entry.status} disabled={saving || reportLoading} onChange={(event) => updateAsbiEntry(entry.id, "status", event.target.value)} /></label>
                  <label className="field-label">Ответственный / подразделение<input value={entry.responsibleUnit} disabled={saving || reportLoading} onChange={(event) => updateAsbiEntry(entry.id, "responsibleUnit", event.target.value)} /></label>
                </div>
                <div className="ltp-shift-error-entry-details ltp-shift-asbi-entry-details">
                  <label className="field-label">Краткое описание<textarea value={entry.description} disabled={saving || reportLoading} onChange={(event) => updateAsbiEntry(entry.id, "description", event.target.value)} /></label>
                </div>
              </article>)}
            </div>
            <div className="ltp-shift-errors-footer">
              <button type="button" className="ltp-shift-add-row" disabled={saving || reportLoading} onClick={addAsbiEntry}><Plus size={14} /> Добавить ТТ</button>
              <span>Записи сохраняются в ltp_1.asbi_3 и привязываются к выбранной дате смены.</span>
            </div>
          </section>;
        }
        if (section.fields[0]?.key === "szrAll") {
          const filledSzrEntries = szrEntries.filter(isFilledSzrEntry).length;
          const hasData = filledSzrEntries > 0 || section.fields.some(({ key }) => metrics[key] > 0);
          return <section className={`panel ltp-shift-summary-card ltp-shift-szr-card ${hasData ? "has-data" : ""}`} key={section.title}>
            <div className="ltp-shift-card-heading">
              <span className={`ltp-shift-card-icon tone-${section.tone}`}><SectionIcon size={16} /></span>
              <div className="ltp-shift-card-title"><small>НАПРАВЛЕНИЕ {String(index + 1).padStart(2, "0")}</small><h3>{section.title}</h3></div>
              <span className="ltp-shift-card-count">{filledSzrEntries} {filledSzrEntries === 1 ? "событие" : "событий"}</span>
            </div>
            <div className="ltp-shift-tap-summary">
              {section.fields.map((field) => <label className="field-label" key={field.key} htmlFor={`ltp-shift-${field.key}`}>
                {field.label}
                <input id={`ltp-shift-${field.key}`} type="number" min="0" step="1" value={metrics[field.key]} disabled={saving || reportLoading || field.key === "szrAll"} onChange={(event) => updateMetric(field.key, event.target.value)} />
              </label>)}
            </div>
            <div className="ltp-shift-error-entries">
              {szrEntries.map((entry, entryIndex) => <article className="ltp-shift-error-entry ltp-shift-szr-entry" key={entry.id}>
                <div className="ltp-shift-error-entry-heading">
                  <div className="ltp-shift-error-entry-title"><span>{String(entryIndex + 1).padStart(2, "0")}</span><strong>Неотработанное событие</strong></div>
                  <span className={`ltp-shift-error-entry-state ${isFilledSzrEntry(entry) ? "is-filled" : ""}`}>{isFilledSzrEntry(entry) ? "Заполнено" : "Черновик"}</span>
                  <button type="button" className="ltp-shift-remove-row" aria-label={`Удалить событие ${entryIndex + 1}`} disabled={saving || reportLoading} onClick={() => removeSzrEntry(entry.id)}><Trash2 size={14} /></button>
                </div>
                <div className="ltp-shift-error-entry-meta ltp-shift-szr-entry-meta">
                  <label className="field-label">Время алерта<input value={entry.alertTime} disabled={saving || reportLoading} onChange={(event) => updateSzrEntry(entry.id, "alertTime", event.target.value)} /></label>
                  <label className="field-label">Ресурс<input value={entry.resource} disabled={saving || reportLoading} onChange={(event) => updateSzrEntry(entry.id, "resource", event.target.value)} /></label>
                  <label className="field-label">Время оповещения<input type="time" value={entry.notifyTime} disabled={saving || reportLoading} onChange={(event) => updateSzrEntry(entry.id, "notifyTime", event.target.value)} /></label>
                  <label className="field-label">Оповещение<select value={entry.notification} disabled={saving || reportLoading} onChange={(event) => updateSzrEntry(entry.id, "notification", event.target.value)}><option>Да</option><option>Нет</option></select></label>
                </div>
                <div className="ltp-shift-error-entry-details ltp-shift-szr-entry-details">
                  <label className="field-label">Дозвон руководству<select value={entry.managementCall} disabled={saving || reportLoading} onChange={(event) => updateSzrEntry(entry.id, "managementCall", event.target.value)}><option>Да</option><option>Нет</option></select></label>
                  <label className="field-label">Время обработки<input type="time" value={entry.processTime} disabled={saving || reportLoading} onChange={(event) => updateSzrEntry(entry.id, "processTime", event.target.value)} /></label>
                  <label className="field-label">Причина<textarea value={entry.reason} disabled={saving || reportLoading} onChange={(event) => updateSzrEntry(entry.id, "reason", event.target.value)} /></label>
                </div>
              </article>)}
            </div>
            <div className="ltp-shift-errors-footer">
              <button type="button" className="ltp-shift-add-row" disabled={saving || reportLoading} onClick={addSzrEntry}><Plus size={14} /> Добавить событие</button>
              <span>События сохраняются в ltp_1.szr_2 и привязываются к выбранной дате смены.</span>
            </div>
          </section>;
        }
        if (section.fields[0]?.key === "tapAll") {
          const filledTapEntries = tapEntries.filter(isFilledTapEntry).length;
          const hasData = filledTapEntries > 0 || section.fields.some(({ key }) => metrics[key] > 0);
          return <section className={`panel ltp-shift-summary-card ltp-shift-tap-card ${hasData ? "has-data" : ""}`} key={section.title}>
            <div className="ltp-shift-card-heading">
              <span className={`ltp-shift-card-icon tone-${section.tone}`}><SectionIcon size={16} /></span>
              <div className="ltp-shift-card-title"><small>НАПРАВЛЕНИЕ {String(index + 1).padStart(2, "0")}</small><h3>{section.title}</h3></div>
              <span className="ltp-shift-card-count">{filledTapEntries} {filledTapEntries === 1 ? "событие" : "событий"}</span>
            </div>
            <div className="ltp-shift-tap-summary">
              {section.fields.map((field) => <label className="field-label" key={field.key} htmlFor={`ltp-shift-${field.key}`}>
                {field.label}
                <input id={`ltp-shift-${field.key}`} type="number" min="0" step="1" value={metrics[field.key]} disabled={saving || reportLoading || field.key === "tapAll"} onChange={(event) => updateMetric(field.key, event.target.value)} />
              </label>)}
            </div>
            <div className="ltp-shift-tap-entries">
              {tapEntries.map((entry, entryIndex) => <article className="ltp-shift-error-entry ltp-shift-tap-entry" key={entry.id}>
                <div className="ltp-shift-error-entry-heading">
                  <div className="ltp-shift-error-entry-title"><span>{String(entryIndex + 1).padStart(2, "0")}</span><strong>Событие из журнала ТАП</strong></div>
                  <span className={`ltp-shift-error-entry-state ${isFilledTapEntry(entry) ? "is-filled" : ""}`}>{isFilledTapEntry(entry) ? "Заполнено" : "Черновик"}</span>
                  <button type="button" className="ltp-shift-remove-row" aria-label={`Удалить событие ${entryIndex + 1}`} disabled={saving || reportLoading} onClick={() => removeTapEntry(entry.id)}><Trash2 size={14} /></button>
                </div>
                <div className="ltp-shift-error-entry-meta ltp-shift-tap-entry-meta">
                  <label className="field-label">Дата возникновения<input type="date" value={entry.eventDate} disabled={saving || reportLoading} onChange={(event) => updateTapEntry(entry.id, "eventDate", event.target.value)} /></label>
                  <label className="field-label">Площадка<input value={entry.area} disabled={saving || reportLoading} onChange={(event) => updateTapEntry(entry.id, "area", event.target.value)} /></label>
                  <label className="field-label">Устройство<input value={entry.device} disabled={saving || reportLoading} onChange={(event) => updateTapEntry(entry.id, "device", event.target.value)} /></label>
                  <label className="field-label">№ ТТ<input value={entry.tt} disabled={saving || reportLoading} onChange={(event) => updateTapEntry(entry.id, "tt", event.target.value)} /></label>
                </div>
                <div className="ltp-shift-error-entry-details ltp-shift-tap-entry-details">
                  <label className="field-label">Алерт<textarea value={entry.alert} disabled={saving || reportLoading} onChange={(event) => updateTapEntry(entry.id, "alert", event.target.value)} /></label>
                  <label className="field-label">Что требует контроля<textarea value={entry.control} disabled={saving || reportLoading} onChange={(event) => updateTapEntry(entry.id, "control", event.target.value)} /></label>
                  <label className="field-label">Действия следующей смены<textarea value={entry.actions} disabled={saving || reportLoading} onChange={(event) => updateTapEntry(entry.id, "actions", event.target.value)} /></label>
                </div>
              </article>)}
            </div>
            <div className="ltp-shift-errors-footer">
              <button type="button" className="ltp-shift-add-row" disabled={saving || reportLoading} onClick={addTapEntry}><Plus size={14} /> Добавить событие</button>
              <span>События сохраняются в ltp_1.tap_1 и привязываются к выбранной дате смены.</span>
            </div>
          </section>;
        }
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
              <span>Заполненные строки сохраняются в ltp_1.errors_8 и привязываются к выбранной дате.</span>
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
