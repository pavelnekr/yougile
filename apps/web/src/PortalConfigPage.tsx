import { useCallback, useEffect, useRef, useState } from "react";
import { CheckCircle2, Info, LoaderCircle, Plus, Save, SlidersHorizontal, Trash2, XCircle } from "lucide-react";
import { apiFetch } from "./apiClient";
import { columnForms, countRu, recipientForms } from "./plural";
import { PORTAL_VERSION } from "./version";

type PortalColumn = { id: string; name: string };
type LoadState = "loading" | "ready" | "error";
type TabKey = "filter" | "avr" | "mail";

// Состояние проверки ID столбца в YouGile. «none» — проверка ещё не запускалась
// (пустой ID), «invalid» — фронтовая проверка формата, остальное — ответ API.
type ColumnStatusInfo =
  | { state: "none"; message: "" }
  | { state: "invalid"; message: string }
  | { state: "checking"; message: "" }
  | { state: "ok"; message: string }
  | { state: "not_found"; message: string }
  | { state: "error"; message: string };

// Параметры SMTP из API. Пароль сервер не отдаёт — только факт, что он задан:
// поле пароля в форме заполняется заново только при смене.
type SmtpSettings = {
  host: string;
  port: number;
  user: string;
  from: string;
  passwordSet: boolean;
};

// ID колонки YouGile — UUID. Как и на бэкенде, сверяем только форму записи,
// без проверки версии: важен сам идентификатор, а не какая версия UUID.
const columnIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const maxColumns = 100;
// Адрес почты для получателей писем. Строгая проверка живёт на бэкенде (zod),
// здесь — грубая, чтобы поймать опечатку до отправки запроса.
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Не удалось выполнить запрос.";
}

/** Первая ошибка списка столбцов или null, если всё заполнено правильно. */
function validateColumns(columns: PortalColumn[]): string | null {
  const firstPositionById = new Map<string, number>();
  for (let index = 0; index < columns.length; index += 1) {
    const column = columns[index];
    const position = index + 1;
    if (!column.name.trim()) return `Строка ${position}: укажите название столбца.`;
    if (!columnIdPattern.test(column.id.trim())) {
      return `Строка ${position}: ID должен быть в формате UUID.`;
    }
    const key = column.id.trim().toLowerCase();
    const firstPosition = firstPositionById.get(key);
    if (firstPosition !== undefined) {
      return `Строка ${position}: этот ID уже указан в строке ${firstPosition}.`;
    }
    firstPositionById.set(key, position);
  }
  return null;
}

/**
 * Проверяет один ID столбца в YouGile (GET /api/portal-config/column-status).
 * Пустой ID — «проверять нечего», неверный формат ловится на месте без запроса.
 */
async function fetchColumnStatus(id: string, signal?: AbortSignal): Promise<ColumnStatusInfo> {
  const trimmed = id.trim();
  if (!trimmed) return { state: "none", message: "" };
  if (!columnIdPattern.test(trimmed)) return { state: "invalid", message: "ID должен быть в формате UUID" };
  try {
    const response = await apiFetch(`/api/portal-config/column-status?id=${encodeURIComponent(trimmed)}`, { signal });
    const data = await response.json().catch(() => null) as {
      status?: string;
      message?: string;
      error?: string;
    } | null;
    if (!response.ok) throw new Error(data?.error ?? "Не удалось проверить столбец.");
    switch (data?.status) {
      case "ok":
        return { state: "ok", message: data.message ?? "Столбец подключён" };
      case "not_found":
        return { state: "not_found", message: data.message ?? "Не найден в YouGile" };
      default:
        return { state: "error", message: data?.message ?? "Не удалось проверить столбец." };
    }
  } catch (reason) {
    if (signal?.aborted) throw reason;
    return { state: "error", message: errorMessage(reason) };
  }
}

/** Бейдж статуса ID столбца: «Проверяем…», «Подключён» или причина ошибки. */
function ColumnStatusBadge({ info }: { info: ColumnStatusInfo }) {
  if (info.state === "none") return null;
  const commonProps = { title: info.message, role: "status" as const };
  if (info.state === "checking") {
    return (
      <span className="column-status column-status-checking" {...commonProps}>
        <LoaderCircle size={12} className="template-spinner" /> Проверяем…
      </span>
    );
  }
  if (info.state === "invalid") {
    return (
      <span className="column-status column-status-error" {...commonProps}>
        <XCircle size={12} /> Неверный формат
      </span>
    );
  }
  if (info.state === "ok") {
    return (
      <span className="column-status column-status-ok" {...commonProps}>
        <CheckCircle2 size={12} /> Подключён
      </span>
    );
  }
  return (
    <span className="column-status column-status-error" {...commonProps}>
      <XCircle size={12} /> {info.state === "not_found" ? "Не найден в YouGile" : "Ошибка проверки"}
    </span>
  );
}

/**
 * Конфигурация портала: ID столбцов YouGile. Раздел виден только администраторам,
 * роль проверена и в меню (App.tsx), и в API (requireRole).
 *
 * Два подраздела: «Фильтрация» — единственный столбец, из которого реально
 * грузится план, и «АВР» — список столбцов, площадки которых собираются в
 * единую таблицу. Оба применяются сразу после сохранения.
 */
export default function PortalConfigPage({
  onPlanColumnChanged,
  onAvrColumnsChanged
}: {
  onPlanColumnChanged?: () => void;
  onAvrColumnsChanged?: () => void;
}) {
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [loadError, setLoadError] = useState("");
  const [tab, setTab] = useState<TabKey>("filter");

  const [plan, setPlan] = useState<PortalColumn>({ id: "", name: "" });
  const [savedPlan, setSavedPlan] = useState<PortalColumn>({ id: "", name: "" });
  const [avr, setAvr] = useState<PortalColumn[]>([]);
  const [savedAvr, setSavedAvr] = useState<PortalColumn[]>([]);

  // Статусы ID столбцов в YouGile: «Подключён» или причина ошибки. Проверяются
  // при загрузке, после сохранения и при потере фокуса полем ID.
  const [planStatus, setPlanStatus] = useState<ColumnStatusInfo>({ state: "none", message: "" });
  const [avrStatuses, setAvrStatuses] = useState<ColumnStatusInfo[]>([]);
  // Отмена висящих проверок при новом вводе: ответ старого запроса не должен
  // перезаписать статус, введённый после него. Ключ — "plan" или номер строки.
  const statusAborters = useRef(new Map<string | number, AbortController>());

  const [mailRecipients, setMailRecipients] = useState<string[]>([]);
  const [savedMailRecipients, setSavedMailRecipients] = useState<string[]>([]);
  const [mailLoaded, setMailLoaded] = useState(false);
  const [mailLoadError, setMailLoadError] = useState("");
  const [smtpConfigured, setSmtpConfigured] = useState(false);

  const emptySmtp: SmtpSettings = { host: "", port: 465, user: "", from: "", passwordSet: false };
  const [smtp, setSmtp] = useState<SmtpSettings>(emptySmtp);
  const [savedSmtp, setSavedSmtp] = useState<SmtpSettings>(emptySmtp);
  // Пароль сервер не возвращает: поле живёт отдельно и отправляется только
  // если пользователь его заполнил. Пустая строка = «не менять пароль».
  const [smtpPassword, setSmtpPassword] = useState("");
  const [smtpLoaded, setSmtpLoaded] = useState(false);
  const [smtpError, setSmtpError] = useState("");
  const [smtpNotice, setSmtpNotice] = useState("");

  const [savingPlan, setSavingPlan] = useState(false);
  const [savingAvr, setSavingAvr] = useState(false);
  const [savingMail, setSavingMail] = useState(false);
  const [savingSmtp, setSavingSmtp] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoadState("loading");
    setLoadError("");
    try {
      const response = await apiFetch("/api/portal-config/columns", { signal });
      const data = await response.json() as { plan?: PortalColumn; avr?: PortalColumn[]; error?: string };
      if (!response.ok) throw new Error(data.error ?? "Не удалось загрузить конфигурацию столбцов.");
      if (!data.plan) throw new Error("Сервер не вернул столбец «Фильтрация».");
      setPlan(data.plan);
      setSavedPlan(data.plan);
      setAvr(data.avr ?? []);
      setSavedAvr(data.avr ?? []);
      setAvrStatuses((data.avr ?? []).map(() => ({ state: "none", message: "" })));
      setLoadState("ready");
      // Сразу проверяем сохранённые ID — статус виден ещё до редактирования.
      if (data.plan?.id.trim()) void runColumnCheck("plan", data.plan.id);
      (data.avr ?? []).forEach((column, index) => {
        if (column.id.trim()) void runColumnCheck(index, column.id);
      });
    } catch (reason) {
      if (signal?.aborted) return;
      setLoadError(errorMessage(reason));
      setLoadState("error");
    }
  }, []);

  // Запуск проверки ID столбца. Ключ «plan» — столбец «Фильтрация», число —
  // строка списка АВР. Начало нового запуска отменяет предыдущий висящий запрос
  // для того же ключа, чтобы устаревший ответ не перезаписал свежий статус.
  const runColumnCheck = useCallback(async (key: "plan" | number, id: string) => {
    statusAborters.current.get(key)?.abort();
    const controller = new AbortController();
    statusAborters.current.set(key, controller);
    const apply = (value: ColumnStatusInfo) => {
      if (key === "plan") {
        setPlanStatus(value);
      } else {
        setAvrStatuses((current) => current.map((item, index) => (index === key ? value : item)));
      }
    };
    apply({ state: "checking", message: "" });
    try {
      const result = await fetchColumnStatus(id, controller.signal);
      if (!controller.signal.aborted) apply(result);
    } catch {
      // Запрос отменён новым запуском — результат устарел, ничего не делаем.
    }
  }, []);

  useEffect(() => {
    return () => {
      statusAborters.current.forEach((controller) => controller.abort());
    };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  // Получатели писем и параметры SMTP живут в другом API-модуле (coordination),
  // поэтому грузятся отдельно от столбцов: сбой одной настройки не должен
  // блокировать другую. Загрузка один раз, дальше страница работает с памятью.
  const loadMail = useCallback(async (signal?: AbortSignal) => {
    setMailLoadError("");
    try {
      const response = await apiFetch("/api/coordination/config", { signal });
      const data = await response.json() as {
        recipients?: string[];
        smtpConfigured?: boolean;
        smtp?: SmtpSettings;
        error?: string;
      };
      if (!response.ok) throw new Error(data.error ?? "Не удалось загрузить получателей писем.");
      const recipients = Array.isArray(data.recipients) ? data.recipients : [];
      setMailRecipients(recipients);
      setSavedMailRecipients(recipients);
      setSmtpConfigured(Boolean(data.smtpConfigured));
      const nextSmtp: SmtpSettings = {
        host: data.smtp?.host ?? "",
        port: Number(data.smtp?.port) || 465,
        user: data.smtp?.user ?? "",
        from: data.smtp?.from ?? "",
        passwordSet: Boolean(data.smtp?.passwordSet)
      };
      setSmtp(nextSmtp);
      setSavedSmtp(nextSmtp);
      setSmtpLoaded(true);
      setMailLoaded(true);
    } catch (reason) {
      if (signal?.aborted) return;
      setMailLoadError(errorMessage(reason));
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void loadMail(controller.signal);
    return () => controller.abort();
  }, [loadMail]);

  const planChanged = plan.id !== savedPlan.id || plan.name !== savedPlan.name;
  const avrChanged = JSON.stringify(avr) !== JSON.stringify(savedAvr);
  const mailChanged = JSON.stringify(mailRecipients) !== JSON.stringify(savedMailRecipients);
  // Пароль в сравнение не входит: он не показывается, а само наличие введённой
  // строки уже делает форму «грязной».
  const portChanged = Number(smtp.port) !== Number(savedSmtp.port);
  const smtpChanged = !smtpLoaded || smtp.host !== savedSmtp.host || portChanged ||
    smtp.user !== savedSmtp.user || smtp.from !== savedSmtp.from || smtpPassword !== "";

  const switchTab = (nextTab: TabKey) => {
    setTab(nextTab);
    setError("");
    setNotice("");
    setSmtpError("");
    setSmtpNotice("");
  };

  const savePlan = async () => {
    if (savingPlan || !planChanged) return;
    const trimmed = { id: plan.id.trim(), name: plan.name.trim() };
    if (!trimmed.name) {
      setNotice("");
      setError("Укажите название столбца.");
      return;
    }
    if (!columnIdPattern.test(trimmed.id)) {
      setNotice("");
      setError("ID столбца должен быть в формате UUID.");
      return;
    }
    setSavingPlan(true);
    setError("");
    setNotice("");
    try {
      const response = await apiFetch("/api/portal-config/plan-column", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(trimmed)
      });
      const data = await response.json() as { plan?: PortalColumn; error?: string };
      if (!response.ok || !data.plan) throw new Error(data.error ?? "Не удалось сохранить столбец «Фильтрация».");
      setPlan(data.plan);
      setSavedPlan(data.plan);
      setPlanStatus({ state: "ok", message: "Столбец подключён" });
      setNotice("Столбец «Фильтрация» сохранён. Обзор уже перечитывает список площадок из новой колонки.");
      onPlanColumnChanged?.();
    } catch (reason) {
      setError(errorMessage(reason));
      // Сервер отклонил столбец (например, не найден в YouGile) — перечитываем
      // статус, чтобы бейдж показал причину, а не устаревший «Подключён».
      statusAborters.current.get("plan")?.abort();
      setPlanStatus({ state: "none", message: "" });
      if (trimmed.id.trim()) void runColumnCheck("plan", trimmed.id);
    } finally {
      setSavingPlan(false);
    }
  };

  const saveAvr = async () => {
    if (savingAvr || !avrChanged) return;
    const trimmed = avr.map((column) => ({ id: column.id.trim(), name: column.name.trim() }));
    const validation = validateColumns(trimmed);
    if (validation) {
      setNotice("");
      setError(validation);
      return;
    }
    setSavingAvr(true);
    setError("");
    setNotice("");
    try {
      const response = await apiFetch("/api/portal-config/avr-columns", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ items: trimmed })
      });
      const data = await response.json() as { avr?: PortalColumn[]; error?: string };
      if (!response.ok || !data.avr) throw new Error(data.error ?? "Не удалось сохранить столбцы АВР.");
      setAvr(data.avr);
      setSavedAvr(data.avr);
      statusAborters.current.forEach((controller) => controller.abort());
      setAvrStatuses(data.avr.map<ColumnStatusInfo>(() => ({ state: "ok", message: "Столбец подключён" })));
      setNotice("Столбцы АВР сохранены. Обзор и страница «Площадки АВР» перечитывают список.");
      // Столбцы изменились, значит изменился и состав площадок АВР — просим
      // обзор перечитать единый список сразу после сохранения.
      onAvrColumnsChanged?.();
    } catch (reason) {
      setError(errorMessage(reason));
      // Сервер отклонил список (например, столбец не найден в YouGile) —
      // перечитываем статусы строк, чтобы бейджи показали причины.
      statusAborters.current.forEach((controller) => controller.abort());
      setAvrStatuses(trimmed.map<ColumnStatusInfo>(() => ({ state: "none", message: "" })));
      trimmed.forEach((column, index) => {
        if (column.id.trim()) void runColumnCheck(index, column.id);
      });
    } finally {
      setSavingAvr(false);
    }
  };

  const updateAvrColumn = (index: number, patch: Partial<PortalColumn>) => {
    setError("");
    setNotice("");
    setAvr((current) => current.map((column, position) => position === index ? { ...column, ...patch } : column));
    // Смена ID делает текущий статус устаревшим: убираем его и гасим проверку.
    if (patch.id !== undefined) {
      statusAborters.current.get(index)?.abort();
      setAvrStatuses((current) => current.map((item, position) => (position === index ? { state: "none", message: "" } : item)));
    }
  };

  const removeAvrColumn = (index: number) => {
    setError("");
    setNotice("");
    statusAborters.current.get(index)?.abort();
    setAvr((current) => current.filter((_, position) => position !== index));
    setAvrStatuses((current) => current.filter((_, position) => position !== index));
  };

  const addAvrColumn = () => {
    setError("");
    setNotice("");
    setAvr((current) => [...current, { id: "", name: "" }]);
    setAvrStatuses((current) => [...current, { state: "none", message: "" }]);
  };

  /** Первая ошибка списка получателей или null, если всё заполнено правильно. */
  const validateMail = (recipients: string[]): string | null => {
    if (recipients.length === 0) return "Укажите хотя бы одного получателя письма.";
    const seen = new Set<string>();
    for (let index = 0; index < recipients.length; index += 1) {
      const address = recipients[index].trim();
      if (!emailPattern.test(address)) return `Строка ${index + 1}: проверьте адрес электронной почты.`;
      const key = address.toLowerCase();
      if (seen.has(key)) return `Строка ${index + 1}: этот адрес уже указан.`;
      seen.add(key);
    }
    return null;
  };

  const saveMail = async () => {
    if (savingMail || !mailChanged) return;
    const trimmed = mailRecipients.map((address) => address.trim());
    const validation = validateMail(trimmed);
    if (validation) {
      setNotice("");
      setError(validation);
      return;
    }
    setSavingMail(true);
    setError("");
    setNotice("");
    try {
      const response = await apiFetch("/api/coordination/recipients", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ recipients: trimmed })
      });
      const data = await response.json() as { recipients?: string[]; error?: string };
      if (!response.ok || !data.recipients) throw new Error(data.error ?? "Не удалось сохранить получателей.");
      setMailRecipients(data.recipients);
      setSavedMailRecipients(data.recipients);
      setNotice("Получатели сохранены — новые письма уйдут по этому списку.");
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setSavingMail(false);
    }
  };

  const updateMailRecipient = (index: number, address: string) => {
    setError("");
    setNotice("");
    setMailRecipients((current) => current.map((item, position) => position === index ? address : item));
  };

  const removeMailRecipient = (index: number) => {
    setError("");
    setNotice("");
    setMailRecipients((current) => current.filter((_, position) => position !== index));
  };

  const addMailRecipient = () => {
    setError("");
    setNotice("");
    setMailRecipients((current) => current.length >= 20 ? current : [...current, ""]);
  };

  const updateSmtpField = (patch: Partial<Omit<SmtpSettings, "passwordSet">>) => {
    setSmtpError("");
    setSmtpNotice("");
    setSmtp((current) => ({ ...current, ...patch }));
  };

  const saveSmtp = async () => {
    if (savingSmtp || !smtpChanged) return;
    const host = smtp.host.trim();
    const port = Number(smtp.port);
    const user = smtp.user.trim();
    const from = smtp.from.trim();
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      setSmtpNotice("");
      setSmtpError("Порт должен быть целым числом от 1 до 65535.");
      return;
    }
    if (from && !emailPattern.test(from)) {
      setSmtpNotice("");
      setSmtpError("Проверьте адрес отправителя (поле «От кого»).");
      return;
    }
    setSavingSmtp(true);
    setSmtpError("");
    setSmtpNotice("");
    try {
      const response = await apiFetch("/api/coordination/smtp", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ host, port, user, from, password: smtpPassword })
      });
      const data = await response.json() as { smtp?: SmtpSettings; error?: string };
      if (!response.ok || !data.smtp) throw new Error(data.error ?? "Не удалось сохранить параметры SMTP.");
      const nextSmtp: SmtpSettings = {
        host: data.smtp.host,
        port: Number(data.smtp.port) || 465,
        user: data.smtp.user,
        from: data.smtp.from,
        passwordSet: Boolean(data.smtp.passwordSet)
      };
      setSmtp(nextSmtp);
      setSavedSmtp(nextSmtp);
      setSmtpPassword("");
      setSmtpConfigured(nextSmtp.host.length > 0);
      setSmtpNotice(nextSmtp.host ? "Настройки SMTP сохранены: отправка писем включена." : "Настройки SMTP сохранены: отправка писем отключена.");
    } catch (reason) {
      setSmtpError(errorMessage(reason));
    } finally {
      setSavingSmtp(false);
    }
  };

  return (
    <section className="section-view portal-config-page">
      <div className="eyebrow"><span className="eyebrow-line" /> ТОЛЬКО ДЛЯ АДМИНИСТРАТОРА</div>
      <div className="section-hero">
        <span className="section-hero-icon"><SlidersHorizontal size={22} /></span>
        <div>
          <h1>Конфигурация портала</h1>
          <p>Столбцы YouGile («Фильтрация» и АВР) и получатели писем раздела «Согласование/Оповещение». Изменения вступают в силу после сохранения.</p>
        </div>
      </div>

      {loadState === "loading" ? (
        <div className="panel portal-config-panel">
          <div className="portal-config-loading"><LoaderCircle size={16} className="template-spinner" /> Загружаем конфигурацию…</div>
        </div>
      ) : loadState === "error" ? (
        <div className="panel portal-config-panel">
          <div className="portal-config-feedback portal-config-feedback-error" role="alert">{loadError}</div>
          <div className="portal-config-actions">
            <button className="outline-button" onClick={() => void load()}>Повторить</button>
          </div>
        </div>
      ) : (
        <div className="panel portal-config-panel">
          <div className="portal-config-tabs" role="tablist" aria-label="Разделы конфигурации">
            <button
              id="portal-config-tab-filter"
              type="button"
              role="tab"
              aria-selected={tab === "filter"}
              aria-controls="portal-config-panel-filter"
              className={`portal-config-tab ${tab === "filter" ? "portal-config-tab-active" : ""}`}
              onClick={() => switchTab("filter")}
            >
              Фильтрация
            </button>
            <button
              id="portal-config-tab-avr"
              type="button"
              role="tab"
              aria-selected={tab === "avr"}
              aria-controls="portal-config-panel-avr"
              className={`portal-config-tab ${tab === "avr" ? "portal-config-tab-active" : ""}`}
              onClick={() => switchTab("avr")}
            >
              АВР <span className="portal-config-tab-count">{avr.length}</span>
            </button>
            <button
              id="portal-config-tab-mail"
              type="button"
              role="tab"
              aria-selected={tab === "mail"}
              aria-controls="portal-config-panel-mail"
              className={`portal-config-tab ${tab === "mail" ? "portal-config-tab-active" : ""}`}
              onClick={() => switchTab("mail")}
            >
              Оповещения <span className="portal-config-tab-count">{mailRecipients.length}</span>
            </button>
          </div>

          <div
            className="portal-config-section"
            id="portal-config-panel-filter"
            role="tabpanel"
            aria-labelledby="portal-config-tab-filter"
            hidden={tab !== "filter"}
          >
            <div className="portal-config-section-heading">
              <div>
                <h2>Столбец Фильтрация</h2>
                <p>Из этой колонки YouGile грузятся площадки для назначения, снятия и проверки работ. Смена ID применяется сразу после сохранения.</p>
              </div>
              <span className={`portal-config-save-state ${planChanged ? "portal-config-save-state-dirty" : ""}`}>
                {planChanged ? "Есть несохранённые изменения" : "Сохранено"}
              </span>
            </div>

            <div className="portal-config-fields">
              <label className="field-label" htmlFor="portal-config-plan-name"><span>Название столбца</span>
                <input
                  id="portal-config-plan-name"
                  value={plan.name}
                  maxLength={80}
                  disabled={savingPlan}
                  placeholder="Например, Фильтрация"
                  onChange={(event) => { setPlan((current) => ({ ...current, name: event.target.value })); setNotice(""); }}
                />
              </label>
              <label className="field-label" htmlFor="portal-config-plan-id"><span>ID столбца в YouGile</span>
                <span className="portal-config-column">
                  <input
                    id="portal-config-plan-id"
                    aria-label="ID столбца в YouGile"
                    value={plan.id}
                    maxLength={36}
                    disabled={savingPlan}
                    placeholder="11111111-1111-4111-8111-111111111111"
                    onChange={(event) => { setPlan((current) => ({ ...current, id: event.target.value })); setPlanStatus({ state: "none", message: "" }); setNotice(""); }}
                    onBlur={() => void runColumnCheck("plan", plan.id)}
                  />
                  <ColumnStatusBadge info={planStatus} />
                </span>
              </label>
            </div>

            {error && <div className="portal-config-feedback portal-config-feedback-error" role="alert">{error}</div>}
            {notice && <div className="portal-config-feedback portal-config-feedback-success" role="status"><CheckCircle2 size={15} />{notice}</div>}

            <div className="portal-config-actions">
              <button
                className="btn-primary"
                disabled={savingPlan || !planChanged}
                onClick={() => void savePlan()}
              >
                {savingPlan ? <LoaderCircle size={15} className="template-spinner" /> : <Save size={15} />}
                {savingPlan ? "Сохраняем…" : "Сохранить"}
              </button>
              {planChanged && (
                <button
                  className="text-button"
                  disabled={savingPlan}
                  onClick={() => {
                    setPlan(savedPlan);
                    setError("");
                    setNotice("");
                    statusAborters.current.get("plan")?.abort();
                    setPlanStatus({ state: "none", message: "" });
                    if (savedPlan.id.trim()) void runColumnCheck("plan", savedPlan.id);
                  }}
                >
                  Отменить
                </button>
              )}
            </div>
          </div>

          <div
            className="portal-config-section"
            id="portal-config-panel-avr"
            role="tabpanel"
            aria-labelledby="portal-config-tab-avr"
            hidden={tab !== "avr"}
          >
            <div className="portal-config-section-heading">
              <div>
                <h2>Столбцы АВР</h2>
                <p>Добавляйте ID столбцов YouGile и их названия кнопкой «Добавить столбец».</p>
              </div>
              <span className={`portal-config-save-state ${avrChanged ? "portal-config-save-state-dirty" : ""}`}>
                {avrChanged ? "Есть несохранённые изменения" : "Сохранено"}
              </span>
            </div>

            {avr.length === 0 ? (
              <div className="portal-config-empty">
                <strong>Столбцы АВР не добавлены.</strong>
                <span>Нажмите «Добавить столбец» и укажите название и ID из YouGile.</span>
              </div>
            ) : (
              <>
                <div className="portal-config-list-count">{countRu(avr.length, columnForms)}</div>
                <div className="portal-config-list">
                  <div className="portal-config-row portal-config-row-head" aria-hidden="true">
                    <span>Название</span><span>ID столбца</span><span />
                  </div>
                  {avr.map((column, index) => (
                    <div className="portal-config-row" key={index}>
                      <input
                        value={column.name}
                        maxLength={80}
                        disabled={savingAvr}
                        placeholder="Название"
                        aria-label={`Название столбца, строка ${index + 1}`}
                        onChange={(event) => updateAvrColumn(index, { name: event.target.value })}
                      />
                      <span className="portal-config-column">
                        <input
                          value={column.id}
                          maxLength={36}
                          disabled={savingAvr}
                          placeholder="00000000-0000-0000-0000-000000000000"
                          aria-label={`ID столбца, строка ${index + 1}`}
                          onChange={(event) => updateAvrColumn(index, { id: event.target.value })}
                          onBlur={() => void runColumnCheck(index, column.id)}
                        />
                        <ColumnStatusBadge info={avrStatuses[index] ?? { state: "none", message: "" }} />
                      </span>
                      <button
                        type="button"
                        className="icon-button portal-config-row-remove"
                        disabled={savingAvr}
                        aria-label={`Удалить столбец, строка ${index + 1}`}
                        onClick={() => removeAvrColumn(index)}
                      >
                        <Trash2 size={15} />
                      </button>
                    </div>
                  ))}
                </div>
              </>
            )}

            <div className="portal-config-note">
              <Info size={14} />
              <span>Столбцы АВР пока только хранятся: операции продолжают использовать столбец «Фильтрация».</span>
            </div>

            {error && <div className="portal-config-feedback portal-config-feedback-error" role="alert">{error}</div>}
            {notice && <div className="portal-config-feedback portal-config-feedback-success" role="status"><CheckCircle2 size={15} />{notice}</div>}

            <div className="portal-config-actions">
              <button
                className="outline-button"
                disabled={savingAvr || avr.length >= maxColumns}
                onClick={addAvrColumn}
              >
                <Plus size={14} /> Добавить столбец
              </button>
              <button
                className="btn-primary"
                disabled={savingAvr || !avrChanged}
                onClick={() => void saveAvr()}
              >
                {savingAvr ? <LoaderCircle size={15} className="template-spinner" /> : <Save size={15} />}
                {savingAvr ? "Сохраняем…" : "Сохранить"}
              </button>
              {avrChanged && (
                <button
                  className="text-button"
                  disabled={savingAvr}
                  onClick={() => {
                    setAvr(savedAvr);
                    setError("");
                    setNotice("");
                    statusAborters.current.forEach((controller) => controller.abort());
                    const statuses = savedAvr.map<ColumnStatusInfo>(() => ({ state: "none", message: "" }));
                    setAvrStatuses(statuses);
                    savedAvr.forEach((column, index) => {
                      if (column.id.trim()) void runColumnCheck(index, column.id);
                    });
                  }}
                >
                  Отменить
                </button>
              )}
            </div>
          </div>

          <div
            className="portal-config-section"
            id="portal-config-panel-mail"
            role="tabpanel"
            aria-labelledby="portal-config-tab-mail"
            hidden={tab !== "mail"}
          >
            <div className="portal-config-section-heading">
              <div>
                <h2>Получатели писем</h2>
                <p>Адреса, на которые уходят письма раздела «Согласование/Оповещение». Список применяется сразу после сохранения.</p>
              </div>
              <span className={`portal-config-save-state ${mailChanged ? "portal-config-save-state-dirty" : ""}`}>
                {mailChanged ? "Есть несохранённые изменения" : "Сохранено"}
              </span>
            </div>

            {mailLoadError ? (
              <div className="portal-config-feedback portal-config-feedback-error" role="alert">
                {mailLoadError}
                <button className="text-button" onClick={() => void loadMail()}>Повторить</button>
              </div>
            ) : !mailLoaded ? (
              <div className="portal-config-loading"><LoaderCircle size={16} className="template-spinner" /> Загружаем получателей…</div>
            ) : mailRecipients.length === 0 ? (
              <div className="portal-config-empty">
                <strong>Получатели не добавлены.</strong>
                <span>Нажмите «Добавить адрес» — без получателей письмо отправить нельзя.</span>
              </div>
            ) : (
              <>
                <div className="portal-config-list-count">{countRu(mailRecipients.length, recipientForms)}</div>
                <div className="portal-config-list">
                  <div className="portal-config-row portal-config-row-head portal-config-row-single" aria-hidden="true">
                    <span>Адрес получателя</span><span />
                  </div>
                  {mailRecipients.map((address, index) => (
                    <div className="portal-config-row portal-config-row-single" key={index}>
                      <input
                        type="email"
                        value={address}
                        maxLength={254}
                        disabled={savingMail}
                        placeholder="name@example.ru"
                        aria-label={`Адрес получателя, строка ${index + 1}`}
                        onChange={(event) => updateMailRecipient(index, event.target.value)}
                      />
                      <button
                        type="button"
                        className="icon-button portal-config-row-remove"
                        disabled={savingMail}
                        aria-label={`Удалить адрес, строка ${index + 1}`}
                        onClick={() => removeMailRecipient(index)}
                      >
                        <Trash2 size={15} />
                      </button>
                    </div>
                  ))}
                </div>
              </>
            )}

            <div className="portal-config-note">
              <Info size={14} />
              <span>
                {smtpConfigured
                  ? "SMTP настроен: письма отправляет сервер портала. Параметры подключения хранятся в этом разделе ниже."
                  : "SMTP не настроен: предпросмотр писем доступен, но отправка будет отклоняться, пока вы не укажете SMTP-сервер в подразделе ниже."}
              </span>
            </div>

            {error && <div className="portal-config-feedback portal-config-feedback-error" role="alert">{error}</div>}
            {notice && <div className="portal-config-feedback portal-config-feedback-success" role="status"><CheckCircle2 size={15} />{notice}</div>}

            <div className="portal-config-actions">
              <button
                className="outline-button"
                disabled={savingMail || mailRecipients.length >= 20}
                onClick={addMailRecipient}
              >
                <Plus size={14} /> Добавить адрес
              </button>
              <button
                className="btn-primary"
                disabled={savingMail || !mailLoaded || !mailChanged}
                onClick={() => void saveMail()}
              >
                {savingMail ? <LoaderCircle size={15} className="template-spinner" /> : <Save size={15} />}
                {savingMail ? "Сохраняем…" : "Сохранить"}
              </button>
              {mailChanged && (
                <button
                  className="text-button"
                  disabled={savingMail}
                  onClick={() => { setMailRecipients(savedMailRecipients); setError(""); setNotice(""); }}
                >
                  Отменить
                </button>
              )}
            </div>

            <div className="portal-config-subsection">
              <div className="portal-config-section-heading">
                <div>
                  <h2>SMTP-сервер</h2>
                  <p>Параметры подключения к почтовому серверу, которым отправляются письма согласования. Пустой сервер означает, что отправка отключена.</p>
                </div>
                <span className={`portal-config-save-state ${smtpChanged ? "portal-config-save-state-dirty" : ""}`}>
                  {smtpChanged ? "Есть несохранённые изменения" : smtpConfigured ? "Подключение задано" : "Отправка отключена"}
                </span>
              </div>

              {!smtpLoaded ? (
                <div className="portal-config-loading"><LoaderCircle size={16} className="template-spinner" /> Загружаем параметры SMTP…</div>
              ) : (
                <>
                  <div className="portal-config-fields">
                    <label className="field-label" htmlFor="portal-config-smtp-host"><span>SMTP-сервер</span>
                      <input
                        id="portal-config-smtp-host"
                        value={smtp.host}
                        maxLength={255}
                        disabled={savingSmtp}
                        placeholder="mail.example.ru"
                        onChange={(event) => updateSmtpField({ host: event.target.value })}
                      />
                    </label>
                    <label className="field-label" htmlFor="portal-config-smtp-port"><span>Порт (465 — TLS, 587/25 — STARTTLS)</span>
                      <input
                        id="portal-config-smtp-port"
                        type="number"
                        min={1}
                        max={65535}
                        value={smtp.port}
                        disabled={savingSmtp}
                        onChange={(event) => updateSmtpField({ port: Number(event.target.value) })}
                      />
                    </label>
                    <label className="field-label" htmlFor="portal-config-smtp-user"><span>Логин (пусто — сервер без аутентификации)</span>
                      <input
                        id="portal-config-smtp-user"
                        value={smtp.user}
                        maxLength={255}
                        disabled={savingSmtp}
                        placeholder="agent@example.ru"
                        onChange={(event) => updateSmtpField({ user: event.target.value })}
                      />
                    </label>
                    <label className="field-label" htmlFor="portal-config-smtp-password"><span>Пароль</span>
                      <input
                        id="portal-config-smtp-password"
                        type="password"
                        maxLength={255}
                        disabled={savingSmtp}
                        autoComplete="new-password"
                        placeholder={smtp.passwordSet ? "•••••••• (не меняется)" : "Оставьте пустым, если не требуется"}
                        value={smtpPassword}
                        onChange={(event) => { setSmtpPassword(event.target.value); setSmtpError(""); setSmtpNotice(""); }}
                      />
                    </label>
                    <label className="field-label" htmlFor="portal-config-smtp-from"><span>От кого (пусто — берётся логин)</span>
                      <input
                        id="portal-config-smtp-from"
                        type="email"
                        value={smtp.from}
                        maxLength={254}
                        disabled={savingSmtp}
                        placeholder="daps-agent@dcoa.ru"
                        onChange={(event) => updateSmtpField({ from: event.target.value })}
                      />
                    </label>
                  </div>

                  <div className="portal-config-note">
                    <Info size={14} />
                    <span>Пароль шифруется и хранится в зашифрованном виде — в интерфейсе он не показывается. Пустое поле при сохранении оставляет текущий пароль без изменений.</span>
                  </div>

                  {smtpError && <div className="portal-config-feedback portal-config-feedback-error" role="alert">{smtpError}</div>}
                  {smtpNotice && <div className="portal-config-feedback portal-config-feedback-success" role="status"><CheckCircle2 size={15} />{smtpNotice}</div>}

                  <div className="portal-config-actions">
                    <button
                      className="btn-primary"
                      disabled={savingSmtp || !smtpChanged}
                      onClick={() => void saveSmtp()}
                    >
                      {savingSmtp ? <LoaderCircle size={15} className="template-spinner" /> : <Save size={15} />}
                      {savingSmtp ? "Сохраняем…" : "Сохранить"}
                    </button>
                    {smtpChanged && (
                      <button
                        className="text-button"
                        disabled={savingSmtp}
                        onClick={() => { setSmtp(savedSmtp); setSmtpPassword(""); setSmtpError(""); setSmtpNotice(""); }}
                      >
                        Отменить
                      </button>
                    )}
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      <footer className="page-footer">
        <span>YouGile Operations Portal <span className="footer-version">{PORTAL_VERSION}</span></span>
        <span>Раздел доступен только администраторам</span>
      </footer>
    </section>
  );
}
