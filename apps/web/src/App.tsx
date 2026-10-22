import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  AlertCircle,
  ArrowDownToLine,
  ArrowLeft,
  ArrowRight,
  ArrowUpRight,
  BellRing,
  CalendarDays,
  Check,
  ClipboardCheck,
  Clock3,
  CheckCircle2,
  Columns3,
  FileSpreadsheet,
  History,
  LayoutDashboard,
  LogOut,
  Menu,
  MessageSquarePlus,
  PanelLeftClose,
  PanelLeftOpen,
  RefreshCw,
  ScrollText,
  Search,
  Settings2,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  TrendingUp,
  Network,
  UsersRound
} from "lucide-react";
import XlsxAssignmentPage from "./XlsxAssignmentPage.js";
import CommentTemplatesPage from "./CommentTemplatesPage.js";
import ImportAuditPage from "./ImportAuditPage.js";
import XlsxRemovalPage from "./XlsxRemovalPage.js";
import CommentPage from "./CommentPage.js";
import CoordinationPage from "./CoordinationPage.js";
import CoordinationLandingPage from "./CoordinationLandingPage.js";
import CoordinationSettingsPage from "./CoordinationSettingsPage.js";
import XlsxWorkCheckPage from "./XlsxWorkCheckPage.js";
import PlanningWorkPage from "./PlanningWorkPage.js";
import DapsDailyKpiPage from "./DapsDailyKpiPage.js";
import ErrorDiagnostics from "./ErrorDiagnostics.js";
import { operationDiagnosticsPayload, type ErrorDetail } from "./diagnostics.js";
import HistoryPage from "./HistoryPage.js";
import AdminUsersPage from "./AdminUsersPage.js";
import LogsPage from "./LogsPage.js";
import PortalConfigPage from "./PortalConfigPage.js";
import { syncSectionUrl, useSectionUrl, type Section } from "./router.js";
import LoginPage, { type PortalUser } from "./LoginPage.js";
import { apiFetch, onSessionExpired } from "./apiClient.js";
import { useStepScroll } from "./useStepScroll.js";
import { countRu, siteForms, taskForms } from "./plural.js";
import { avatarInitial } from "./avatar.js";
import ActiveOperationsPanel from "./ActiveOperationsPanel.js";
import CompletedOperationsPanel from "./CompletedOperationsPanel.js";
import { PORTAL_VERSION } from "./version";

type Health = "loading" | "ok" | "error";
type SiteLoadState = "loading" | "ready" | "error";
type PlannedSite = {
  taskId: string;
  siteNumber: string;
  title: string;
  assignedCount: number;
  completed: boolean;
  updatedAt: string | null;
};
type AssignmentUser = { id: string; name: string; status: string | null };
type AssignmentPreview = {
  user: AssignmentUser;
  items: {
    taskId: string;
    siteNumber: string;
    title: string;
    currentUserIds: string[];
    alreadyAssigned: boolean;
    valid: boolean;
  }[];
};
type AssignmentOperation = {
  id: string;
  status: "QUEUED" | "RUNNING" | "SUCCEEDED" | "PARTIAL" | "FAILED" | "CANCELLED";
  total: number;
  completed: number;
  failed: number;
  message: string | null;
  items: { siteId: string; status: string; errorMessage: string | null; details?: ErrorDetail | null }[];
  errorDetails?: ErrorDetail | null;
};
type WorkTypeStatistic = {
  month: string;
  total: number;
  unclassified: number;
  items: { type: "filter" | "balancers" | "bypasses" | "ehw" | "other"; label: string; count: number }[];
};
// Ответ GET /api/sites/in-avr: единый список площадок по столбцам АВР из
// «Конфигурации портала». Карточка на обзоре и страница «Площадки АВР»
// читают один и тот же ответ, поэтому числа у них всегда совпадают.
type AvrSite = PlannedSite & { columnId: string; columnName: string };
type AvrSitesList = {
  columns: { id: string; name: string; count: number }[];
  items: AvrSite[];
  total: number;
};

// adminOnly — пункт показывается только роли ADMIN. Проверка роли есть и в API
// (requireRole), здесь она нужна, чтобы не показывать недоступный раздел.
const navigation: { label: Section; icon: typeof LayoutDashboard; adminOnly?: boolean }[] = [
  { label: "Управление работами в YouGile", icon: LayoutDashboard },
  { label: "DAPS", icon: Sparkles },
  { label: "Согласование/Оповещение", icon: BellRing },
  { label: "Планирование Работ", icon: CalendarDays },
  { label: "Учётные записи", icon: UsersRound, adminOnly: true },
  { label: "Логирование", icon: ScrollText, adminOnly: true },
  // Последний пункт списка: конфигурация нужна редко и только администраторам.
  { label: "Конфигурация портала", icon: SlidersHorizontal, adminOnly: true }
];

const workspaceBySection: Partial<Record<Section, string>> = {
  "Управление работами в YouGile": "WORK_MANAGEMENT",
  "DAPS": "DAPS",
  "Ежедневный отчет по KPI": "DAPS",
  "Netbox": "DAPS",
  "Площадки": "WORK_MANAGEMENT",
  "Площадки АВР": "WORK_MANAGEMENT",
  "Массовое назначение инженеров": "WORK_MANAGEMENT",
  "Точечное назначение инженера": "WORK_MANAGEMENT",
  "Снять инженеров": "WORK_MANAGEMENT",
  "Написать комментарий": "WORK_MANAGEMENT",
  "Проверить работы": "WORK_MANAGEMENT",
  "Аудит": "WORK_MANAGEMENT",
  "История": "WORK_MANAGEMENT",
  "Настройки": "WORK_MANAGEMENT",
  "Согласование/Оповещение": "COORDINATION",
  "Согласование АВР": "COORDINATION",
  "Настройки согласования": "COORDINATION",
  "Планирование Работ": "WORK_PLANNING"
};

const actions = [
  {
    number: "01",
    title: "Точечное назначение инженера",
    description: "Укажите ФИО, выберите одну площадку и добавьте комментарий к назначению.",
    icon: ArrowUpRight,
    tone: "blue",
    section: "Точечное назначение инженера" as Section
  },
  {
    number: "02",
    title: "Массовое назначение инженеров",
    description: "Выберите площадки и инженера, проверьте план изменений и подтвердите назначение.",
    icon: ArrowUpRight,
    tone: "blue",
    section: "Массовое назначение инженеров" as Section
  },
  {
    number: "03",
    title: "Массовое снятие с площадки",
    description: "Загрузите XLSX или выберите файл из аудита, чтобы проверить назначения для снятия.",
    icon: ArrowDownToLine,
    tone: "violet",
    section: "Снять инженеров" as Section
  },
  {
    number: "04",
    title: "Проверить работы",
    description: "Загрузите XLSX или выберите файл из аудита, чтобы посмотреть последние комментарии по площадкам.",
    icon: ClipboardCheck,
    tone: "green",
    section: "Проверить работы" as Section
  },
  {
    number: "05",
    title: "Написать комментарий",
    description: "Выберите одну или несколько площадок и напишите комментарий в чат задач YouGile.",
    icon: MessageSquarePlus,
    tone: "orange",
    section: "Написать комментарий" as Section
  }
];

// Пока идёт операция в YouGile, сервер отдаёт списки площадок из кэша с флагом
// paused и просит не перечитывать задачи (иначе YouGile отвечает HTTP 429).
// Пока пауза держится, повторяем запрос с этим шагом: как только операции
// закончились, приходит свежий список.
const pausedSitesRetryMs = 4_000;

// Единая формулировка паузы для карточек и списков площадок.
const sitesPausedText = "Обновление приостановлено: идёт операция в YouGile";

function compareSiteNumbers(left: string, right: string): number {
  // Номер остаётся строкой (в нём могут быть ведущие нули), но порядок
  // получается числовым: 21 перед 321, а 021 стабильно рядом с 21.
  const normalizedLeft = left.replace(/^0+(?=\d)/, "");
  const normalizedRight = right.replace(/^0+(?=\d)/, "");
  if (normalizedLeft.length !== normalizedRight.length) return normalizedLeft.length - normalizedRight.length;
  const digitsOrder = normalizedLeft.localeCompare(normalizedRight);
  return digitsOrder || left.localeCompare(right);
}

function SitesPausedNote({ className = "sites-message" }: { className?: string }) {
  return <div className={`${className} sites-message-paused`}>{sitesPausedText}</div>;
}

function App() {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    try {
      return window.localStorage.getItem("portal-sidebar-collapsed") === "true";
    } catch {
      return false;
    }
  });
  const [sessionUser, setSessionUser] = useState<PortalUser | null>(null);
  // null = проверяем, false = гость, true = вход выполнен.
  const [sessionChecked, setSessionChecked] = useState(false);
  const [section, navigate] = useSectionUrl();
  const [health, setHealth] = useState<Health>("loading");
  const yougileConnected = sessionUser?.yougileTokenConfigured ?? false;
  const [sites, setSites] = useState<PlannedSite[]>([]);
  const [siteLoadState, setSiteLoadState] = useState<SiteLoadState>("loading");
  const [siteError, setSiteError] = useState("");
  // true — сервер отдал последний кэш, потому что сейчас идёт операция в YouGile.
  const [sitePaused, setSitePaused] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [siteRefreshKey, setSiteRefreshKey] = useState(0);
  const refreshSites = useCallback(() => setSiteRefreshKey((key) => key + 1), []);
  const [avrSites, setAvrSites] = useState<AvrSitesList | null>(null);
  const [avrLoadState, setAvrLoadState] = useState<SiteLoadState>("loading");
  const [avrError, setAvrError] = useState("");
  const [avrPaused, setAvrPaused] = useState(false);
  const [avrRefreshKey, setAvrRefreshKey] = useState(0);
  const refreshAvrSites = useCallback(() => setAvrRefreshKey((key) => key + 1), []);

  // При загрузке страницы спрашиваем у API, есть ли действующая сессия.
  // Именно это убирает повторный ввод логина и пароля после перезагрузки.
  useEffect(() => {
    const controller = new AbortController();
    apiFetch("/api/auth/session", { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) return null;
        return await response.json() as { user?: PortalUser };
      })
      .then((data) => setSessionUser(data?.user ?? null))
      .catch(() => setSessionUser(null))
      .finally(() => {
        if (!controller.signal.aborted) setSessionChecked(true);
      });
    return () => controller.abort();
  }, []);

  // Глобальная обработка 401: apiClient перехватывает любой отказ защищённого
  // эндпоинта и сообщает сюда. Сессия сбрасывается, форма входа показывается на
  // весь экран, а страницы размонтируются и отменяют свои запросы.
  // Адрес не трогаем: после входа пользователь возвращается на тот же раздел,
  // поэтому ссылку с историей можно переслать даже без действующей сессии.
  useEffect(() => onSessionExpired(() => {
    setSessionUser(null);
  }), []);

  const signOut = useCallback(async () => {
    try {
      await apiFetch("/api/auth/logout", { method: "POST" });
    } finally {
      // Выход делаем и при ошибке сети: локально всё равно показываем форму входа.
      setSessionUser(null);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    apiFetch("/api/health", { signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error("Backend недоступен");
        return response.json();
      })
      .then((data: { status?: string }) => {
        setHealth(data.status === "ok" ? "ok" : "error");
      })
      .catch(() => {
        if (!controller.signal.aborted) setHealth("error");
      });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    let retry: ReturnType<typeof setTimeout> | undefined;
    let cancelled = false;

    const load = () => {
      apiFetch("/api/sites/in-plan", { signal: controller.signal })
        .then(async (response) => {
          if (!response.ok) {
            const error = await response.json().catch(() => null) as { error?: string } | null;
            throw new Error(error?.error ?? "Не удалось загрузить площадки.");
          }
          return response.json() as Promise<{ items: PlannedSite[]; paused?: boolean }>;
        })
        .then((data) => {
          if (cancelled) return;
          setSites(data.items);
          setSiteLoadState("ready");
          setSiteError("");
          // Сервер приостановил обновление, потому что идёт операция: показываем
          // последний кэш и повторяем запрос, пока операции не закончатся.
          setSitePaused(Boolean(data.paused));
          if (data.paused) retry = setTimeout(load, pausedSitesRetryMs);
        })
        .catch((error: unknown) => {
          if (cancelled || controller.signal.aborted) return;
          setSiteError(error instanceof Error ? error.message : "Не удалось загрузить площадки.");
          setSiteLoadState("error");
        });
    };

    void load();
    return () => {
      cancelled = true;
      controller.abort();
      if (retry) clearTimeout(retry);
    };
  }, [siteRefreshKey]);

  // Единый список площадок АВР: служит и карточке на обзоре, и странице
  // «Площадки АВР». Смена столбцов в конфигурации увеличивает avrRefreshKey,
  // поэтому данные перечитываются сразу после сохранения.
  useEffect(() => {
    const controller = new AbortController();
    let retry: ReturnType<typeof setTimeout> | undefined;
    let cancelled = false;

    const load = () => {
      apiFetch("/api/sites/in-avr", { signal: controller.signal })
        .then(async (response) => {
          if (!response.ok) {
            const error = await response.json().catch(() => null) as { error?: string } | null;
            throw new Error(error?.error ?? "Не удалось загрузить площадки АВР.");
          }
          return response.json() as Promise<AvrSitesList & { paused?: boolean }>;
        })
        .then((data) => {
          if (cancelled) return;
          setAvrSites(data);
          setAvrLoadState("ready");
          setAvrError("");
          // Как и у списка площадок: во время операции показываем кэш и
          // повторяем запрос, пока операции не закончатся.
          setAvrPaused(Boolean(data.paused));
          if (data.paused) retry = setTimeout(load, pausedSitesRetryMs);
        })
        .catch((error: unknown) => {
          if (cancelled || controller.signal.aborted) return;
          setAvrError(error instanceof Error ? error.message : "Не удалось загрузить площадки АВР.");
          setAvrLoadState("error");
        });
    };

    void load();
    return () => {
      cancelled = true;
      controller.abort();
      if (retry) clearTimeout(retry);
    };
  }, [avrRefreshKey]);

  const chooseSection = (label: Section) => {
    navigate(label);
    setMobileNavOpen(false);
  };

  const isAdmin = sessionUser?.role === "ADMIN";
  const visibleNavigation = useMemo(
    () => navigation.filter((item) => {
      if (item.adminOnly) return isAdmin;
      const workspace = workspaceBySection[item.label];
      return isAdmin || !workspace || sessionUser?.workspaces.includes(workspace);
    }),
    [isAdmin, sessionUser]
  );
  // Если роль сменили, пока пользователь сидел в портале, раздел мог остаться
  // открытым — возвращаем на обзор, а не показываем ошибку 403.
  // Проверка именно на sessionUser, а не на !isAdmin: пока сессия проверяется,
  // роль ещё неизвестна, и иначе глубокая ссылка /admin/users потерялась бы при
  // первом рендере. Гость админ-раздел тоже увидеть не может, но форму входа
  // показываем по любой ссылке: после входа раздел откроется, если права есть.
  const isSectionAllowed = (value: Section) => {
    const item = navigation.find((candidate) => candidate.label === value);
    const workspace = workspaceBySection[value];
    return (!item?.adminOnly || isAdmin) && (isAdmin || !workspace || sessionUser?.workspaces.includes(workspace));
  };
  const activeSection: Section = sessionUser && !isSectionAllowed(section)
    ? (visibleNavigation[0]?.label ?? "Управление работами в YouGile")
    : section;
  // «Согласование АВР» — подраздел раздела «Согласование/Оповещение»: карточка
  // на странице раздела открывает его по собственному адресу. Подсветка меню
  // и пункт навигации остаются у родительского раздела.
  const parentSectionOf: Partial<Record<Section, Section>> = {
    "Согласование АВР": "Согласование/Оповещение",
    "Настройки согласования": "Согласование/Оповещение",
    "Ежедневный отчет по KPI": "DAPS",
    "Netbox": "DAPS"
  };
  const activeNavSection = parentSectionOf[activeSection] ?? activeSection;

  // Адрес приводим к открытому разделу: неизвестный путь, лишний слеш и раздел
  // без прав заменяются корнем через replaceState, без записи в историю.
  useEffect(() => {
    syncSectionUrl(activeSection);
  }, [activeSection]);

  // Заголовок вкладки повторяет раздел: в закладках и истории браузера видно,
  // какая страница портала открыта, а не всегда «Портал операций».
  useEffect(() => {
    document.title = activeSection === "Управление работами в YouGile"
      ? "Портал операций — YouGile"
      : `${activeSection} — Портал операций`;
  }, [activeSection]);

  if (!sessionChecked) {
    return (
      <div className="session-check">
        <span className="session-check-spinner" />
        <p>Проверяем сессию…</p>
      </div>
    );
  }

  if (!sessionUser) {
    // Гость: либо ещё не вошёл, либо сессия истекла — в обоих случаях нужна форма входа.
    return <LoginPage onAuthenticated={setSessionUser} />;
  }

  return (
    <div className="app-shell">
      {mobileNavOpen && <button className="mobile-scrim" aria-label="Закрыть меню" onClick={() => setMobileNavOpen(false)} />}
      <aside className={`sidebar ${mobileNavOpen ? "sidebar-open" : ""} ${sidebarCollapsed ? "sidebar-collapsed" : ""}`}>
        <div className="sidebar-brand-row">
          <a className="brand" href="#" onClick={(event) => { event.preventDefault(); chooseSection("Управление работами в YouGile"); }}>
            <span className="brand-mark"><span /><span /><span /><span /></span>
            <span className="brand-copy"><strong>DAPS</strong><small>OPERATIONS PORTAL</small></span>
          </a>
        </div>

        <p className="nav-caption">РАБОЧЕЕ ПРОСТРАНСТВО</p>
        <nav id="portal-sidebar-navigation" className="navigation" aria-label="Основная навигация">
          {visibleNavigation.map(({ label, icon: Icon }) => (
            <button key={label} title={sidebarCollapsed ? label : undefined} aria-label={label} className={`nav-link ${activeNavSection === label ? "nav-link-active" : ""}`} onClick={() => chooseSection(label)}>
              <Icon size={18} strokeWidth={1.8} />
              <span>{label}</span>
            </button>
          ))}
        </nav>

        <div className="sidebar-bottom">
          <button className="profile" type="button" onClick={() => void signOut()} title={sidebarCollapsed ? `Выйти из портала · ${sessionUser.displayName}` : "Выйти из портала"}>
            <span className="profile-avatar">{sessionUser.displayName.slice(0, 1).toLocaleUpperCase("ru")}</span>
            <span className="profile-copy"><strong>{sessionUser.displayName}</strong><small>{sessionUser.login} · выход</small></span>
            <LogOut size={15} />
          </button>
        </div>
      </aside>

      <button
        type="button"
        className="sidebar-collapse-button"
        aria-label={sidebarCollapsed ? "Развернуть меню" : "Свернуть меню"}
        aria-expanded={!sidebarCollapsed}
        aria-controls="portal-sidebar-navigation"
        title={sidebarCollapsed ? "Развернуть меню" : "Свернуть меню"}
        onClick={() => setSidebarCollapsed((collapsed) => {
          const next = !collapsed;
          try { window.localStorage.setItem("portal-sidebar-collapsed", String(next)); } catch { /* хранилище может быть отключено */ }
          return next;
        })}
      >
        {sidebarCollapsed ? <PanelLeftOpen size={17} /> : <PanelLeftClose size={17} />}
      </button>

      <main className="main-area">
        <header className="topbar">
          <button className="icon-button mobile-menu" aria-label="Открыть меню" onClick={() => setMobileNavOpen(true)}><Menu size={19} /></button>
          <div className="breadcrumbs"><span>Портал операций</span><span className="crumb-separator">/</span><strong>{activeSection}</strong></div>
          <div className="topbar-actions">
            <div className={`service-status status-${health}`}><span className="status-dot" />{health === "ok" ? "API и сервисы доступны" : health === "loading" ? "Проверка API" : "API не подключён"}</div>
            <button className="icon-button search-button" aria-label="Поиск"><Search size={18} /></button>
            <span className="topbar-avatar">{avatarInitial(sessionUser.displayName)}</span>
          </div>
        </header>

        <div className="page-content">
          {activeSection === "Управление работами в YouGile" && !yougileConnected && health !== "loading" && (
            <div className="yougile-offline-banner">
              <AlertCircle size={16} />
              <div>
                <strong>Портал не подключён к YouGile</strong>
                <span>
                  Для вашей учётной записи не настроен личный токен YouGile. Обратитесь к администратору,
                  чтобы добавить токен в разделе «Учётные записи».
                </span>
              </div>
            </div>
          )}
          {activeSection === "Управление работами в YouGile" ? (
            <Overview
              onNavigate={chooseSection}
              health={health}
              sites={sites}
              siteLoadState={siteLoadState}
              siteError={siteError}
              sitePaused={sitePaused}
              avrSites={avrSites}
              avrLoadState={avrLoadState}
              avrError={avrError}
              avrPaused={avrPaused}
            />
          ) : activeSection === "DAPS" ? (
            <DapsLandingPage onNavigate={chooseSection} />
          ) : activeSection === "Ежедневный отчет по KPI" ? (
            <DapsDailyKpiPage canEdit={sessionUser.role !== "VIEWER"} onBack={() => chooseSection("DAPS")} />
          ) : activeSection === "Netbox" ? (
            <NetboxPage onBack={() => chooseSection("DAPS")} />
          ) : activeSection === "Согласование/Оповещение" ? (
            <CoordinationLandingPage onNavigate={chooseSection} />
          ) : activeSection === "Согласование АВР" ? (
            <CoordinationPage onBack={() => chooseSection("Согласование/Оповещение")} />
          ) : activeSection === "Настройки согласования" ? (
            <CoordinationSettingsPage onBack={() => chooseSection("Согласование/Оповещение")} />
          ) : activeSection === "Планирование Работ" ? (
            <PlanningWorkPage canEdit={sessionUser.role !== "VIEWER"} />
          ) : activeSection === "Площадки" ? (
            <SitesPage sites={sites} loadState={siteLoadState} error={siteError} paused={sitePaused} />
          ) : activeSection === "Площадки АВР" ? (
            <AvrSitesPage avrSites={avrSites} loadState={avrLoadState} error={avrError} paused={avrPaused} />
          ) : activeSection === "Массовое назначение инженеров" ? (
            <XlsxAssignmentPage onComplete={refreshSites} />
          ) : activeSection === "Точечное назначение инженера" ? (
            <AssignmentPage sites={sites} loadState={siteLoadState} avrSites={avrSites} avrLoadState={avrLoadState} onComplete={refreshSites} pointMode />
          ) : activeSection === "Снять инженеров" ? (
            <XlsxRemovalPage onComplete={refreshSites} />
          ) : activeSection === "Написать комментарий" ? (
            <CommentPage
              sites={sites}
              loadState={siteLoadState}
              siteError={siteError}
              paused={sitePaused}
              onComplete={refreshSites}
              onOpenHistory={() => chooseSection("История")}
            />
          ) : activeSection === "Проверить работы" ? (
            <XlsxWorkCheckPage />
          ) : activeSection === "Настройки" ? (
            <CommentTemplatesPage />
          ) : activeSection === "Аудит" ? (
            <ImportAuditPage />
          ) : activeSection === "История" ? (
            <HistoryPage />
          ) : activeSection === "Учётные записи" ? (
            // activeSection уже проверен на роль выше, поэтому сюда попадает только ADMIN.
            <AdminUsersPage
              currentUser={sessionUser}
              onCurrentUserTokenChanged={(configured) => {
                setSessionUser((user) => user ? { ...user, yougileTokenConfigured: configured } : user);
              }}
            />
          ) : activeSection === "Логирование" ? (
            // Раздел adminOnly, поэтому сюда попадает только ADMIN.
            <LogsPage />
          ) : activeSection === "Конфигурация портала" ? (
            // Раздел adminOnly, поэтому сюда попадает только ADMIN.
            // Смена столбца плана меняет источник списка площадок — просим
            // обзор перечитать его сразу после сохранения.
            <PortalConfigPage onPlanColumnChanged={refreshSites} onAvrColumnsChanged={refreshAvrSites} />
          ) : (
            <SectionPage section={activeSection} health={health} />
          )}
        </div>
      </main>
    </div>
  );
}

function DapsLandingPage({ onNavigate }: { onNavigate: (section: Section) => void }) {
  return (
    <section className="section-view">
      <div className="eyebrow"><span className="eyebrow-line" /> DAPS</div>
      <div className="section-hero">
        <span className="section-hero-icon"><Sparkles size={22} /></span>
        <div><h1>DAPS</h1><p>Рабочее пространство ежедневного контроля KPI.</p></div>
      </div>
      <section className="section-heading">
        <div><h2>Инструменты</h2><p>Ежедневная сводка показателей и сетевые данные площадок.</p></div>
      </section>
      <section className="actions-grid daps-card-grid">
        <button className="action-card" onClick={() => onNavigate("Ежедневный отчет по KPI")}>
          <div className="action-card-top"><span className="action-icon green"><TrendingUp size={19} /></span></div>
          <h3>Ежедневный отчет по KPI</h3>
          <p>Сводка показателей за день, месячные средние и динамика КПЭ К3.</p>
          <span className="action-link">Открыть отчёт <ArrowRight size={15} /></span>
        </button>
        <button className="action-card" onClick={() => onNavigate("Netbox")}>
          <div className="action-card-top"><span className="action-icon green"><Network size={19} /></span></div>
          <h3>Netbox</h3>
          <p>Просмотр портов ОС и байпаса по номеру площадки.</p>
          <span className="action-link">Открыть Netbox <ArrowRight size={15} /></span>
        </button>
      </section>
      <footer className="page-footer"><span>YouGile Operations Portal <span className="footer-version">{PORTAL_VERSION}</span></span><span>Портал управления операциями</span></footer>
    </section>
  );
}

function NetboxPage({ onBack }: { onBack: () => void }) {
  type NetboxSaveState = "idle" | "dirty" | "saving" | "saved" | "error" | "duplicate";
  type NetboxInterfaceRow = { id: string; deviceId: number; interfaceId: number; role: string; port: string; host: string; savedPort: string; savedHost: string; bypassHost: string; bypassPort: string; tspuId: string; linkUpdatedAt: string | null; behindDevice: string; behindPort: string; linkCapacity: string; hostSaveState: NetboxSaveState; portSaveState: NetboxSaveState; hostSaveMessage?: string; portSaveMessage?: string; hostChanged: boolean; portChanged: boolean; needsOsCable?: boolean };
  const [siteNumber, setSiteNumber] = useState("");
  const [searchedSiteNumber, setSearchedSiteNumber] = useState<string | null>(null);
  const [lookup, setLookup] = useState<{ state: "idle" | "loading" | "found" | "missing" | "error"; message?: string }>({ state: "idle" });
  const [netboxProgress, setNetboxProgress] = useState<{ phase: string; percent: number } | null>(null);
  const [netboxInterfaces, setNetboxInterfaces] = useState<NetboxInterfaceRow[]>([]);
  const [netboxExporting, setNetboxExporting] = useState(false);
  const [netboxExportError, setNetboxExportError] = useState("");
  const [netboxImporting, setNetboxImporting] = useState(false);
  const [netboxImportMessage, setNetboxImportMessage] = useState("");
  const [netboxImportError, setNetboxImportError] = useState("");
  const [showNetboxExtraFields, setShowNetboxExtraFields] = useState(false);
  const netboxImportFileRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (searchedSiteNumber === null) return;
    const controller = new AbortController();
    const progressId = `nb_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    setLookup({ state: "loading" });
    setNetboxProgress({ phase: "Подключаемся к NetBox…", percent: 2 });
    setNetboxInterfaces([]);
    const pollProgress = async () => {
      try {
        const progressResponse = await apiFetch(`/api/daps/netbox/site/progress?progressId=${encodeURIComponent(progressId)}`, { signal: controller.signal });
        if (!progressResponse.ok) return;
        const progress = await progressResponse.json() as { phase: string; percent: number; interfaces?: NetboxInterfaceRow[] };
        setNetboxProgress({ phase: progress.phase, percent: progress.percent });
        if (progress.interfaces) setNetboxInterfaces(progress.interfaces.map((item) => ({ ...item, savedHost: item.host, savedPort: item.port, hostSaveState: "idle", portSaveState: "idle", hostChanged: false, portChanged: false })));
      } catch { /* The main lookup request reports errors. */ }
    };
    const progressTimer = window.setInterval(() => void pollProgress(), 700);
    apiFetch(`/api/daps/netbox/site?slug=${encodeURIComponent(searchedSiteNumber)}&progressId=${encodeURIComponent(progressId)}`, { signal: controller.signal })
      .then(async (response) => {
        const data = await response.json() as {
          found?: boolean;
          interfaces?: { id: string; deviceId: number; interfaceId: number; role: string; port: string; host: string; bypassHost: string; bypassPort: string; tspuId: string; linkUpdatedAt: string | null; behindDevice: string; behindPort: string; linkCapacity: string; needsOsCable?: boolean }[];
          error?: string;
        };
        if (!response.ok) throw new Error(data.error ?? "Не удалось проверить площадку в NetBox.");
        setNetboxInterfaces((data.interfaces ?? []).map((item) => ({ ...item, savedHost: item.host, savedPort: item.port, hostSaveState: "idle", portSaveState: "idle", hostChanged: false, portChanged: false })));
        setLookup({ state: data.found ? "found" : "missing" });
        setNetboxProgress({ phase: data.found ? `Готово: ${(data.interfaces ?? []).length} ссылок` : "Площадка не найдена", percent: 100 });
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setLookup({ state: "error", message: error instanceof Error ? error.message : "Не удалось проверить площадку в NetBox." });
      }).finally(() => window.clearInterval(progressTimer));
    return () => {
      controller.abort();
      window.clearInterval(progressTimer);
    };
  }, [searchedSiteNumber]);
  const handleSiteNumberChange = (value: string) => {
    setSiteNumber(value);
    setSearchedSiteNumber(null);
    setLookup({ state: "idle" });
    setNetboxInterfaces([]);
    setNetboxImportMessage("");
    setNetboxImportError("");
    setNetboxExportError("");
  };
  const saveNetboxValue = async (row: NetboxInterfaceRow, field: "host" | "port"): Promise<boolean> => {
    const value = row[field].trim();
    const savedValue = field === "host" ? row.savedHost : row.savedPort;
    if (value === savedValue) return true;
    const statusField = field === "host" ? "hostSaveState" : "portSaveState";
    const messageField = field === "host" ? "hostSaveMessage" : "portSaveMessage";
    const rowMatches = (item: NetboxInterfaceRow) => item.id === row.id;
    setNetboxInterfaces((rows) => rows.map((item) => rowMatches(item) ? { ...item, [statusField]: "saving" } : item));
    let duplicateMessage = "Дубликат";
    try {
      const response = await apiFetch("/api/daps/netbox/interface", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ siteSlug: searchedSiteNumber, sourceDeviceId: row.deviceId, sourceInterfaceId: row.interfaceId, hostName: field === "host" ? value : row.host.trim(), portName: field === "port" ? value : row.port.trim() })
      });
      const data = await response.json() as { saved?: boolean; deviceId?: number; interfaceId?: number; host?: string; port?: string; linkUpdatedAt?: string; code?: string; duplicateDeviceId?: number; duplicateInterfaceId?: number; error?: string };
      if (!response.ok || !data.saved) {
        if (data.code === "DUPLICATE_LINK") {
          const duplicate = netboxInterfaces.find((item) => item.deviceId === data.duplicateDeviceId && item.interfaceId === data.duplicateInterfaceId);
          if (duplicate?.bypassHost && duplicate.bypassPort) duplicateMessage = `Дубликат порта на ${duplicate.bypassHost}, ${duplicate.bypassPort}`;
          throw new Error("DUPLICATE_LINK");
        }
        throw new Error(data.error ?? "Не удалось сохранить изменение в NetBox.");
      }
      setNetboxInterfaces((rows) => rows.map((item) => rowMatches(item) ? {
        ...item,
        id: `${data.deviceId ?? item.deviceId}-${data.interfaceId ?? item.interfaceId}-${item.id.split("-").at(-1) ?? "0"}`,
        deviceId: data.deviceId ?? item.deviceId,
        interfaceId: data.interfaceId ?? item.interfaceId,
        host: data.host ?? item.host,
        port: data.port ?? item.port,
        savedHost: data.host ?? item.host,
        savedPort: data.port ?? item.port,
        linkUpdatedAt: data.linkUpdatedAt ?? item.linkUpdatedAt,
        hostChanged: (data.host ?? item.host) !== item.savedHost,
        portChanged: (data.port ?? item.port) !== item.savedPort,
        hostSaveMessage: undefined,
        portSaveMessage: undefined,
        hostSaveState: "saved",
        portSaveState: "saved"
      } : item));
      return true;
    } catch (error) {
      const isDuplicate = error instanceof Error && error.message === "DUPLICATE_LINK";
      setNetboxInterfaces((rows) => rows.map((item) => rowMatches(item) ? { ...item, [statusField]: isDuplicate ? "duplicate" : "error", [messageField]: isDuplicate ? duplicateMessage : undefined } : item));
      if (isDuplicate) setLookup((current) => current.state === "found" ? current : { state: "found" });
      else setLookup({ state: "error", message: error instanceof Error ? error.message : "Не удалось сохранить изменение в NetBox." });
      return false;
    }
  };
  const saveStateLabel = (state: NetboxSaveState, message?: string) => state === "saving" ? "Сохранение в NetBox…" : state === "saved" ? "Сохранено" : state === "duplicate" ? message ?? "Дубликат" : state === "error" ? "Не сохранено — измените поле и повторите" : state === "dirty" ? "Изменение не сохранено" : "";
  const exportNetboxXlsx = async () => {
    if (!searchedSiteNumber || netboxInterfaces.length === 0 || netboxExporting) return;
    setNetboxExporting(true);
    setNetboxExportError("");
    try {
      const exportedTspuIds = new Set<string>();
      const response = await apiFetch("/api/daps/netbox/site.xlsx", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          siteSlug: searchedSiteNumber,
          rows: netboxInterfaces.map(({ tspuId, host, port, bypassHost, bypassPort, linkUpdatedAt, behindDevice, behindPort, linkCapacity }) => {
            const displayTspuId = tspuId && exportedTspuIds.has(tspuId) ? "" : tspuId;
            if (tspuId) exportedTspuIds.add(tspuId);
            return {
              tspuId: displayTspuId, host, port, linkUpdatedAt: linkUpdatedAt ?? "", bypassHost, bypassPort,
              ...(showNetboxExtraFields ? { behindDevice, behindPort, linkCapacity } : {})
            };
          })
        })
      });
      if (!response.ok) {
        const data = await response.json() as { error?: string };
        throw new Error(data.error ?? "Не удалось скачать таблицу XLSX.");
      }
      const file = await response.blob();
      const url = URL.createObjectURL(file);
      const link = document.createElement("a");
      link.href = url;
      link.download = `netbox-links-${searchedSiteNumber.replace(/[^a-zA-Z0-9_-]/g, "_")}.xlsx`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) {
      setNetboxExportError(error instanceof Error ? error.message : "Не удалось скачать таблицу XLSX.");
    } finally {
      setNetboxExporting(false);
    }
  };
  const downloadNetboxTxt = () => {
    if (!searchedSiteNumber || netboxInterfaces.length === 0) return;
    const lines: string[] = [];
    let previousLinkKey: string | null = null;
    for (const row of netboxInterfaces) {
      const portPair = row.bypassPort.replace(/\/[12]$/, "");
      const linkKey = row.tspuId ? `tspu:${row.tspuId}` : `bypass:${row.bypassHost}:${portPair}`;
      if (previousLinkKey !== null && linkKey !== previousLinkKey) lines.push("");
      lines.push(`${row.host} ${row.port} --> ${row.bypassHost} ${row.bypassPort}`);
      previousLinkKey = linkKey;
    }
    const file = new Blob([`\uFEFF${lines.join("\r\n")}`], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(file);
    const link = document.createElement("a");
    link.href = url;
    link.download = `netbox-links-${searchedSiteNumber.replace(/[^a-zA-Z0-9_-]/g, "_")}.txt`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const importNetboxXlsx = async (file: File) => {
    if (!searchedSiteNumber || netboxImporting) return;
    setNetboxImporting(true);
    setNetboxImportError("");
    setNetboxImportMessage("Читаем XLSX…");
    try {
      const form = new FormData();
      form.append("file", file);
      const response = await apiFetch("/api/daps/netbox/site.xlsx/parse", { method: "POST", body: form });
      const data = await response.json() as { rows?: { rowNumber: number; host: string; port: string; bypassHost: string; bypassPort: string }[]; error?: string };
      if (!response.ok) throw new Error(data.error ?? "Не удалось прочитать XLSX.");
      const normalize = (value: string) => value.normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase("ru");
      const pairKey = (host: string, port: string) => `${normalize(host)}\u0000${normalize(port)}`;
      const byBypass = new Map<string, NetboxInterfaceRow[]>();
      for (const row of netboxInterfaces) {
        if (row.needsOsCable) continue;
        const key = pairKey(row.bypassHost, row.bypassPort);
        byBypass.set(key, [...(byBypass.get(key) ?? []), row]);
      }
      const rows = data.rows ?? [];
      const seen = new Set<string>();
      let changed = 0;
      let unchanged = 0;
      let skipped = 0;
      let failed = 0;
      const skippedLines: number[] = [];
      for (let index = 0; index < rows.length; index += 1) {
        const uploaded = rows[index];
        setNetboxImportMessage(`Применяем строки ${index + 1} из ${rows.length}…`);
        const key = pairKey(uploaded.bypassHost, uploaded.bypassPort);
        const matches = byBypass.get(key) ?? [];
        if (seen.has(key) || matches.length !== 1) {
          skipped += 1;
          skippedLines.push(uploaded.rowNumber);
          continue;
        }
        seen.add(key);
        const current = matches[0];
        const nextHost = uploaded.host.trim();
        const nextPort = uploaded.port.trim();
        const hostChanged = nextHost !== current.host.trim();
        const portChanged = nextPort !== current.port.trim();
        if (!hostChanged && !portChanged) {
          unchanged += 1;
          continue;
        }
        const updated = { ...current, host: nextHost, port: nextPort,
          hostSaveState: hostChanged ? "dirty" as const : current.hostSaveState,
          portSaveState: portChanged ? "dirty" as const : current.portSaveState };
        setNetboxInterfaces((currentRows) => currentRows.map((item) => item.id === current.id ? updated : item));
        const saved = await saveNetboxValue(updated, hostChanged ? "host" : "port");
        if (saved) changed += 1;
        else failed += 1;
      }
      const skippedDetail = skippedLines.length ? ` Строки без однозначной пары Байпаса: ${skippedLines.slice(0, 10).join(", ")}${skippedLines.length > 10 ? "…" : ""}.` : "";
      setNetboxImportMessage(`Готово: изменено ${changed}, без изменений ${unchanged}, не сопоставлено ${skipped}, ошибок сохранения ${failed}.${skippedDetail}`);
    } catch (error) {
      setNetboxImportError(error instanceof Error ? error.message : "Не удалось загрузить XLSX.");
      setNetboxImportMessage("");
    } finally {
      setNetboxImporting(false);
      if (netboxImportFileRef.current) netboxImportFileRef.current.value = "";
    }
  };
  const displayedTspuIds = new Set<string>();
  return <section className="section-view daps-report-page">
    <div className="eyebrow"><span className="eyebrow-line" /> DAPS · NETBOX</div>
    <div className="section-hero daps-report-hero"><span className="section-hero-icon"><Network size={22} /></span><div><h1>Netbox</h1><p>Порты ОС и байпаса по площадке.</p></div><button type="button" className="text-button" onClick={onBack}><ArrowLeft size={15} /> Назад</button></div>
    <form className="panel daps-daily-controls netbox-controls" onSubmit={(event) => { event.preventDefault(); if (siteNumber.trim()) setSearchedSiteNumber(siteNumber.trim()); }}>
      <label className="field-label" htmlFor="netbox-site-number"><span>Номер площадки</span>
        <input id="netbox-site-number" type="text" inputMode="text" value={siteNumber} onChange={(event) => handleSiteNumberChange(event.target.value)} placeholder="Введите номер площадки" />
      </label>
      <button type="submit" className="btn-primary" disabled={!siteNumber.trim() || lookup.state === "loading"}><Search size={15} /> Поиск</button>
      {lookup.state === "loading" && <span className="netbox-lookup netbox-lookup-loading" role="status">Поиск в NetBox…</span>}
      {lookup.state === "found" && <span className="netbox-lookup netbox-lookup-found" role="status">Площадка найдена</span>}
      {lookup.state === "missing" && <span className="netbox-lookup netbox-lookup-missing" role="status">Площадка не найдена</span>}
      {lookup.state === "error" && <span className="netbox-lookup netbox-lookup-error" role="alert">{lookup.message}</span>}
      {searchedSiteNumber !== null && netboxInterfaces.length > 0 && <>
        <input ref={netboxImportFileRef} className="netbox-file-input" type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" onChange={(event) => { const file = event.target.files?.[0]; if (file) void importNetboxXlsx(file); }} />
        <div className="netbox-file-actions">
          <div className="netbox-upload-actions">
          <button type="button" className="outline-button" disabled={netboxImporting || lookup.state !== "found"} onClick={() => netboxImportFileRef.current?.click()}><FileSpreadsheet size={15} />{netboxImporting ? "Загрузка…" : "Загрузить XLSX"}</button>
          <button type="button" className="outline-button" aria-expanded={showNetboxExtraFields} aria-controls="netbox-links-table" onClick={() => setShowNetboxExtraFields((shown) => !shown)}>{showNetboxExtraFields ? "Скрыть доп. поля" : "Показать доп. поля"}</button>
          </div>
          <div className="netbox-download-actions">
            <button type="button" className="outline-button" disabled={netboxExporting || netboxImporting || lookup.state !== "found"} onClick={() => void exportNetboxXlsx()}><FileSpreadsheet size={15} />{netboxExporting ? "Формируем XLSX…" : "Скачать XLSX"}</button>
            <button type="button" className="outline-button" disabled={netboxExporting || netboxImporting || lookup.state !== "found"} onClick={downloadNetboxTxt}><ScrollText size={15} />Скачать TXT</button>
          </div>
        </div>
      </>}
      {netboxExportError && <span className="netbox-lookup netbox-lookup-error" role="alert">{netboxExportError}</span>}
      {netboxImportMessage && <span className="netbox-lookup" role="status">{netboxImportMessage}</span>}
      {netboxImportError && <span className="netbox-lookup netbox-lookup-error" role="alert">{netboxImportError}</span>}
    </form>
    {searchedSiteNumber !== null && <section className="panel daps-daily-table-panel">
      <div className="panel-heading"><div><h2>Порты и хосты</h2><p>Площадка {searchedSiteNumber}. Изменения сохраняются в NetBox после выхода из поля.</p></div></div>
      {lookup.state === "loading" && netboxProgress && <div className="netbox-progress" role="status" aria-live="polite"><div className="netbox-progress-copy"><span>{netboxProgress.phase}</span><span>{netboxProgress.percent}%</span></div><div className="netbox-progress-track"><span style={{ transform: `scaleX(${netboxProgress.percent / 100})` }} /></div></div>}
      <div className="daps-daily-table-wrap"><table id="netbox-links-table" className="daps-daily-table netbox-table"><thead><tr><th>№</th><th>Дата изменения линка</th><th>Хост ОС</th><th>Порт ОС</th><th>Хост Байпаса</th><th>Порт Байпаса</th>{showNetboxExtraFields && <><th>Устройство за байпасом</th><th>Порт устройства</th><th>Линк</th></>}</tr></thead><tbody>
        {netboxInterfaces.map((item, index) => {
          const displayTspuId = item.tspuId && displayedTspuIds.has(item.tspuId) ? "" : item.tspuId || "—";
          if (item.tspuId) displayedTspuIds.add(item.tspuId);
          return <tr key={item.id}>
          <td>{displayTspuId}</td>
          <td className="netbox-link-updated-cell">{item.linkUpdatedAt && Number.isFinite(new Date(item.linkUpdatedAt).getTime()) ? new Date(item.linkUpdatedAt).toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "—"}</td>
          <td className={item.hostChanged ? "netbox-import-changed-cell" : undefined}>{item.needsOsCable ? <span className="netbox-missing-os">Требуется создать кабель в NetBox</span> : <><input className="netbox-edit-input netbox-edit-host" type="text" aria-label={`Хост ОС, строка ${index + 1}`} value={item.host} disabled={netboxImporting || item.hostSaveState === "saving" || item.portSaveState === "saving"} onChange={(event) => setNetboxInterfaces((rows) => rows.map((row) => row.id === item.id ? { ...row, host: event.target.value, hostSaveState: event.target.value === row.savedHost ? "idle" : "dirty", hostSaveMessage: undefined } : row))} onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }} onBlur={() => void saveNetboxValue(item, "host")} /><span className={`netbox-save-note ${item.hostSaveState === "error" || item.hostSaveState === "duplicate" ? "netbox-save-error" : ""}`} role="status">{saveStateLabel(item.hostSaveState, item.hostSaveMessage)}</span></>}</td>
          <td className={item.portChanged ? "netbox-import-changed-cell" : undefined}>{item.needsOsCable ? <span className="netbox-missing-os">Требуется создать кабель в NetBox</span> : <><input className="netbox-edit-input netbox-edit-port" type="text" aria-label={`Порт ОС, строка ${index + 1}`} value={item.port} disabled={netboxImporting || item.portSaveState === "saving"} onChange={(event) => setNetboxInterfaces((rows) => rows.map((row) => row.id === item.id ? { ...row, port: event.target.value, portSaveState: event.target.value === row.savedPort ? "idle" : "dirty", portSaveMessage: undefined } : row))} onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }} onBlur={() => void saveNetboxValue(item, "port")} /><span className={`netbox-save-note ${item.portSaveState === "error" || item.portSaveState === "duplicate" ? "netbox-save-error" : ""}`} role="status">{saveStateLabel(item.portSaveState, item.portSaveMessage)}</span></>}</td>
          <td><span className="netbox-cell-main">{item.bypassHost || "—"}</span></td>
          <td><span className="netbox-cell-main">{item.bypassPort || "—"}</span></td>
          {showNetboxExtraFields && <>
            <td><span className="netbox-cell-main">{item.behindDevice || "—"}</span></td>
            <td><span className="netbox-cell-main">{item.behindPort || "—"}</span></td>
            <td><span className="netbox-cell-main">{item.linkCapacity || "—"}</span></td>
          </>}
        </tr>;
        })}
        {lookup.state === "found" && netboxInterfaces.length === 0 && <tr><td className="netbox-empty-row" colSpan={showNetboxExtraFields ? 9 : 6}>Не найдены порты ОС, связанные с байпасом.</td></tr>}
      </tbody></table></div>
    </section>}
  </section>;
}

function Overview({
  onNavigate,
  health,
  sites,
  siteLoadState,
  siteError,
  sitePaused,
  avrSites,
  avrLoadState,
  avrError,
  avrPaused
}: {
  onNavigate: (section: Section) => void;
  health: Health;
  sites: PlannedSite[];
  siteLoadState: SiteLoadState;
  siteError: string;
  sitePaused: boolean;
  avrSites: AvrSitesList | null;
  avrLoadState: SiteLoadState;
  avrError: string;
  avrPaused: boolean;
}) {
  const [workTypeStatistics, setWorkTypeStatistics] = useState<WorkTypeStatistic | null>(null);
  const [workTypeStatisticsError, setWorkTypeStatisticsError] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    apiFetch("/api/history/work-types", { signal: controller.signal })
      .then(async (response) => {
        const data = await response.json() as WorkTypeStatistic & { error?: string };
        if (!response.ok) throw new Error(data.error ?? "Не удалось загрузить статистику видов работ.");
        setWorkTypeStatistics(data);
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
          setWorkTypeStatisticsError(error instanceof Error ? error.message : "Не удалось загрузить статистику видов работ.");
        }
      });
    return () => controller.abort();
  }, []);

  const avrCountFoot =
    avrLoadState === "loading" ? "Загрузка списка из YouGile"
      : avrLoadState === "error" ? "Не удалось загрузить данные"
        : avrSites && avrSites.columns.length === 0 ? "Столбцы АВР не добавлены"
          : "Активные задачи в столбцах АВР";

  return (
    <>
      <section className="welcome-row">
        <div>
          <div className="eyebrow"><span className="eyebrow-line" /> РАБОЧЕЕ ПРОСТРАНСТВО</div>
          <h1>Управление YouGile <span className="wave">✳</span></h1>
          <p className="welcome-subtitle">Управляйте назначениями инженеров и проверяйте данные в одном месте.</p>
        </div>
        <button className="outline-button" onClick={() => onNavigate("История")}><Clock3 size={16} /> История операций</button>
      </section>

      {health === "error" && (
        <div className="setup-notice">
          <span className="notice-icon"><Activity size={18} /></span>
          <div><strong>Backend пока не подключён</strong><p>Структура сайта готова. После настройки API здесь появятся актуальные статусы операций и данные YouGile.</p></div>
          <span className="notice-tag">НАСТРОЙКА</span>
        </div>
      )}

      <ActiveOperationsPanel onNavigate={onNavigate} />
      <CompletedOperationsPanel />

      <section className="stats-grid" aria-label="Сводка">
        <StatCard
          title="Площадки в АВР"
          value={avrLoadState === "ready" && avrSites ? avrSites.total.toLocaleString("ru-RU") : "—"}
          foot={avrCountFoot}
          icon={Columns3}
          tone="violet"
          onClick={() => onNavigate("Площадки АВР")}
        />
        <StatCard
          title="Площадки в фильтрации"
          value={siteLoadState === "ready" ? sites.length.toLocaleString("ru-RU") : "—"}
          foot={siteLoadState === "ready" ? "Активные задачи в колонке фильтрации" : siteLoadState === "error" ? "Не удалось загрузить данные" : "Загрузка списка из YouGile"}
          icon={LayoutDashboard}
          tone="blue"
          onClick={() => onNavigate("Площадки")}
        />
        <WorkTypeStatsCard
          statistics={workTypeStatistics}
          error={workTypeStatisticsError}
          onClick={() => onNavigate("История")}
        />
      </section>

      <section className="section-heading">
        <div><h2>Что хотите сделать?</h2><p>Выберите операцию — сначала покажем план изменений.</p></div>
        <span className="secure-label"><ShieldCheck size={15} /> Подтверждение перед записью</span>
      </section>

      <section className="actions-grid">
        {actions.map((action) => {
          const Icon = action.icon;
          return (
            <button className="action-card" key={action.number} onClick={() => onNavigate(action.section)}>
              <div className="action-card-top"><span className={`action-icon ${action.tone}`}><Icon size={19} /></span><span className="action-number">{action.number}</span></div>
              <h3>{action.title}</h3>
              <p>{action.description}</p>
              <span className="action-link">Открыть сценарий <ArrowRight size={15} /></span>
            </button>
          );
        })}
      </section>

      <section className="section-heading">
        <div><h2>Инструменты</h2><p>Аудит загрузок, журнал операций и шаблоны комментариев.</p></div>
      </section>

      <section className="actions-grid overview-tools-grid" aria-label="Инструменты управления работами">
        <button className="action-card" onClick={() => onNavigate("Аудит")}>
          <div className="action-card-top"><span className="action-icon violet"><ClipboardCheck size={19} /></span></div>
          <h3>Аудит</h3>
          <p>Просматривайте загруженные XLSX-файлы и проверяйте строки импорта.</p>
          <span className="action-link">Открыть аудит <ArrowRight size={15} /></span>
        </button>
        <button className="action-card" onClick={() => onNavigate("История")}>
          <div className="action-card-top"><span className="action-icon blue"><History size={19} /></span></div>
          <h3>История</h3>
          <p>Смотрите завершённые операции и статистику назначений.</p>
          <span className="action-link">Открыть историю <ArrowRight size={15} /></span>
        </button>
        <button className="action-card" onClick={() => onNavigate("Настройки")}>
          <div className="action-card-top"><span className="action-icon orange"><Settings2 size={19} /></span></div>
          <h3>Настройки</h3>
          <p>Создавайте и редактируйте шаблоны комментариев.</p>
          <span className="action-link">Открыть настройки <ArrowRight size={15} /></span>
        </button>
      </section>

      <section className="bottom-grid">
        <div className="panel activity-panel planned-sites-preview">
          <div className="panel-heading"><div><h2>Площадки в фильтрации</h2><p>{sitePaused ? sitesPausedText : siteLoadState === "ready" ? `${countRu(sites.length, taskForms)} из YouGile` : "Актуальный список из YouGile"}</p></div><button className="text-button" onClick={() => onNavigate("Площадки")}>Все площадки <ArrowRight size={14} /></button></div>
          {sitePaused && sites.length === 0 ? (
            <SitesPausedNote />
          ) : siteLoadState === "loading" ? (
            <div className="sites-message">Загружаем список площадок…</div>
          ) : siteLoadState === "error" ? (
            <div className="sites-message sites-message-error">{siteError}</div>
          ) : sites.length === 0 ? (
            <div className="sites-message">В колонке плана пока нет площадок.</div>
          ) : (
            <div className="preview-list">
              {sites.slice(0, 5).map((site) => <SiteRow key={site.taskId} site={site} />)}
            </div>
          )}
        </div>
        <div className="panel activity-panel avr-sites-preview">
          <div className="panel-heading"><div><h2>Площадки в АВР</h2><p>{avrPaused ? sitesPausedText : avrLoadState === "ready" ? `${countRu(avrSites?.total ?? 0, taskForms)} из YouGile` : "Актуальный список из YouGile"}</p></div><button className="text-button" onClick={() => onNavigate("Площадки АВР")}>Все площадки <ArrowRight size={14} /></button></div>
          {avrPaused && (!avrSites || avrSites.items.length === 0) ? (
            <SitesPausedNote />
          ) : avrLoadState === "loading" ? (
            <div className="sites-message">Загружаем список площадок…</div>
          ) : avrLoadState === "error" ? (
            <div className="sites-message sites-message-error">{avrError}</div>
          ) : avrSites && avrSites.columns.length === 0 ? (
            <div className="sites-message">Столбцы АВР не добавлены в конфигурации портала.</div>
          ) : !avrSites || avrSites.items.length === 0 ? (
            <div className="sites-message">В столбцах АВР пока нет площадок.</div>
          ) : (
            <div className="preview-list">
              {avrSites.items.slice(0, 5).map((site) => (
                <SiteRow key={site.taskId} site={site} columnName={site.columnName} />
              ))}
            </div>
          )}
        </div>
      </section>

      <footer className="page-footer"><span>YouGile Operations Portal <span className="footer-version">{PORTAL_VERSION}</span></span><span>Портал управления операциями</span></footer>
    </>
  );
}

function StatCard({ title, value, foot, icon: Icon, tone, onClick }: { title: string; value: string; foot: string; icon: typeof LayoutDashboard; tone: string; onClick?: () => void }) {
  const content = (
    <>
      <div className="stat-top"><span className={`stat-icon ${tone}`}><Icon size={17} /></span><span className="stat-title">{title}</span></div>
      <strong className="stat-value">{value}</strong>
      <span className="stat-foot">{foot}</span>
    </>
  );

  return onClick
    ? <button className="stat-card stat-card-button" onClick={onClick}>{content}</button>
    : <div className="stat-card">{content}</div>;
}

function WorkTypeStatsCard({
  statistics,
  error,
  onClick
}: {
  statistics: WorkTypeStatistic | null;
  error: string;
  onClick: () => void;
}) {
  const maximum = Math.max(1, ...(statistics?.items.map((item) => item.count) ?? []));

  return (
    <button className="stat-card stat-card-button work-type-stat-card" onClick={onClick} title="Открыть историю операций">
      <div className="stat-top"><span className="stat-icon orange"><Activity size={17} /></span><span className="stat-title">Назначено работ за месяц</span></div>
      <strong className="stat-value">{error ? "—" : statistics ? statistics.total.toLocaleString("ru-RU") : "—"}</strong>
      {error ? <span className="stat-foot work-type-stat-error">{error}</span> : statistics ? (
        <div className="work-type-stat-list">
          {statistics.items.map((item) => (
            <div className="work-type-stat-row" key={item.type}>
              <span>{item.label}</span>
              <span className="work-type-stat-track"><i className={`work-type-stat-fill work-type-${item.type}`} style={{ width: `${item.count ? Math.max(5, item.count / maximum * 100) : 0}%` }} /></span>
              <strong>{item.count.toLocaleString("ru-RU")}</strong>
            </div>
          ))}
        </div>
      ) : <span className="stat-foot">Загружаем статистику…</span>}
    </button>
  );
}

function SiteRow({ site, columnName }: { site: PlannedSite; columnName?: string }) {
  return (
    <div className="site-row">
      <span className="site-number">{site.siteNumber}</span>
      <span className="site-title" title={site.title}>{site.title}</span>
      {columnName
        // У площадки в АВР вместо статуса показываем, из какого столбца она взята.
        ? <span className="site-column" title={columnName}>{columnName}</span>
        : <span className={`site-status ${site.completed ? "site-status-complete" : ""}`}>{site.completed ? "Выполнена" : "В плане"}</span>}
    </div>
  );
}

function SitesPage({ sites, loadState, error, paused }: { sites: PlannedSite[]; loadState: SiteLoadState; error: string; paused: boolean }) {
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const pageSize = 25;
  const filteredSites = sites.filter((site) => `${site.siteNumber} ${site.title}`.toLocaleLowerCase("ru").includes(query.trim().toLocaleLowerCase("ru")));
  const pageCount = Math.max(1, Math.ceil(filteredSites.length / pageSize));
  const currentPage = Math.min(page, pageCount);
  const visibleSites = filteredSites.slice((currentPage - 1) * pageSize, currentPage * pageSize);

  return (
    <section className="section-view">
      <div className="eyebrow"><span className="eyebrow-line" /> ДАННЫЕ YOUGILE</div>
      <div className="sites-page-heading">
        <div><h1>Площадки в плане</h1><p>{paused ? sitesPausedText : "Активные задачи из колонки плана в YouGile."}</p></div>
        <span className="sites-total">{loadState === "ready" ? countRu(sites.length, siteForms) : "Загрузка…"}</span>
      </div>
      <div className="panel sites-table-panel">
        <div className="sites-toolbar">
          <div><strong>Список площадок</strong><span>{loadState === "ready" ? `Найдено: ${filteredSites.length.toLocaleString("ru-RU")}` : "Источник: YouGile"}</span></div>
          <label className="sites-search"><Search size={15} /><input value={query} onChange={(event) => { setQuery(event.target.value); setPage(1); }} placeholder="Поиск по номеру или адресу" /></label>
        </div>
        {paused && sites.length === 0 ? (
          <SitesPausedNote className="sites-page-message" />
        ) : loadState === "loading" ? (
          <div className="sites-page-message">Загружаем список из YouGile…</div>
        ) : loadState === "error" ? (
          <div className="sites-page-message sites-message-error">{error}</div>
        ) : filteredSites.length === 0 ? (
          <div className="sites-page-message">{query ? "По вашему запросу площадок не найдено." : "В колонке плана пока нет площадок."}</div>
        ) : (
          <>
            <div className="sites-table-header"><span>№ площадки</span><span>Площадка / адрес</span><span>Инженеры</span><span>Статус</span><span>ID задачи</span></div>
            {visibleSites.map((site) => (
              <div className="sites-table-row" key={site.taskId}>
                <span className="site-number">{site.siteNumber}</span>
                <span className="site-title" title={site.title}>{site.title}</span>
                <span className="site-assignees">{site.assignedCount}</span>
                <span><span className={`site-status ${site.completed ? "site-status-complete" : ""}`}>{site.completed ? "Выполнена" : "В плане"}</span></span>
                <span className="site-task-id" title={site.taskId}>{site.taskId.slice(0, 8)}…</span>
              </div>
            ))}
            <div className="sites-pagination">
              <span>Показано {(currentPage - 1) * pageSize + 1}–{Math.min(currentPage * pageSize, filteredSites.length)} из {filteredSites.length.toLocaleString("ru-RU")}</span>
              <div><button disabled={currentPage <= 1} onClick={() => setPage(currentPage - 1)}>Назад</button><span>{currentPage} / {pageCount}</span><button disabled={currentPage >= pageCount} onClick={() => setPage(currentPage + 1)}>Вперёд</button></div>
            </div>
          </>
        )}
      </div>
      <footer className="page-footer"><span>YouGile Operations Portal <span className="footer-version">{PORTAL_VERSION}</span></span><span>Обновление списка при открытии страницы · кэш API 30 секунд</span></footer>
    </section>
  );
}

/**
 * Единая таблица площадок АВР: все столбцы из «Конфигурация портала» → «АВР»
 * свалены в один список, у каждой площадки видно, из какого столбца она взята.
 * Каркас, поиск и пагинация те же, что у списка «Площадки в плане».
 */
function AvrSitesPage({ avrSites, loadState, error, paused }: { avrSites: AvrSitesList | null; loadState: SiteLoadState; error: string; paused: boolean }) {
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [columnFilter, setColumnFilter] = useState("");
  const pageSize = 25;
  const sites = avrSites?.items ?? [];
  const normalizedQuery = query.trim().toLocaleLowerCase("ru");
  const filteredSites = sites.filter((site) => {
    if (columnFilter && site.columnId !== columnFilter) return false;
    return `${site.siteNumber} ${site.title} ${site.columnName}`.toLocaleLowerCase("ru").includes(normalizedQuery);
  });
  const pageCount = Math.max(1, Math.ceil(filteredSites.length / pageSize));
  const currentPage = Math.min(page, pageCount);
  const visibleSites = filteredSites.slice((currentPage - 1) * pageSize, currentPage * pageSize);

  return (
    <section className="section-view">
      <div className="eyebrow"><span className="eyebrow-line" /> ДАННЫЕ YOUGILE</div>
      <div className="sites-page-heading">
        <div><h1>Площадки в АВР</h1><p>{paused ? sitesPausedText : "Активные задачи из столбцов АВР в YouGile."}</p></div>
        <span className="sites-total">{loadState === "ready" ? countRu(sites.length, siteForms) : "Загрузка…"}</span>
      </div>
      <div className="panel sites-table-panel">
        <div className="sites-toolbar">
          <div><strong>Список площадок</strong><span>{loadState === "ready" ? `Найдено: ${filteredSites.length.toLocaleString("ru-RU")}` : "Источник: YouGile"}</span></div>
          <label className="sites-search"><Search size={15} /><input value={query} onChange={(event) => { setQuery(event.target.value); setPage(1); }} placeholder="Поиск по номеру, адресу или столбцу" /></label>
        </div>
        {/* Фильтр по столбцам имеет смысл только когда их несколько: при одном столбце он занимает место и ничего не фильтрует. */}
        {loadState === "ready" && avrSites && avrSites.columns.length > 1 && (
          <div className="avr-column-filter">
            <button className={!columnFilter ? "avr-column-chip avr-column-chip-active" : "avr-column-chip"} onClick={() => { setColumnFilter(""); setPage(1); }}>
              Все столбцы · {countRu(sites.length, siteForms)}
            </button>
            {avrSites.columns.map((column) => (
              <button
                key={column.id}
                className={columnFilter === column.id ? "avr-column-chip avr-column-chip-active" : "avr-column-chip"}
                onClick={() => { setColumnFilter(column.id); setPage(1); }}
              >
                {column.name || "Без названия"} · {countRu(column.count, siteForms)}
              </button>
            ))}
          </div>
        )}
        {paused && sites.length === 0 ? (
          <SitesPausedNote className="sites-page-message" />
        ) : loadState === "loading" ? (
          <div className="sites-page-message">Загружаем список из YouGile…</div>
        ) : loadState === "error" ? (
          <div className="sites-page-message sites-message-error">{error}</div>
        ) : !avrSites || avrSites.columns.length === 0 ? (
          <div className="sites-page-message">Столбцы АВР не добавлены в конфигурации портала.</div>
        ) : filteredSites.length === 0 ? (
          <div className="sites-page-message">{query || columnFilter ? "По вашему запросу площадок не найдено." : "В столбцах АВР пока нет площадок."}</div>
        ) : (
          <>
            <div className="sites-table-header avr-sites-table"><span>№ площадки</span><span>Площадка / адрес</span><span>Столбец</span><span>Инженеры</span><span>Статус</span><span>ID задачи</span></div>
            {visibleSites.map((site) => (
              <div className="sites-table-row avr-sites-table" key={site.taskId}>
                <span className="site-number">{site.siteNumber}</span>
                <span className="site-title" title={site.title}>{site.title}</span>
                <span className="site-column" title={site.columnName}>{site.columnName || "Без названия"}</span>
                <span className="site-assignees">{site.assignedCount}</span>
                <span><span className={`site-status ${site.completed ? "site-status-complete" : ""}`}>{site.completed ? "Выполнена" : "В плане"}</span></span>
                <span className="site-task-id" title={site.taskId}>{site.taskId.slice(0, 8)}…</span>
              </div>
            ))}
            <div className="sites-pagination">
              <span>Показано {(currentPage - 1) * pageSize + 1}–{Math.min(currentPage * pageSize, filteredSites.length)} из {filteredSites.length.toLocaleString("ru-RU")}</span>
              <div><button disabled={currentPage <= 1} onClick={() => setPage(currentPage - 1)}>Назад</button><span>{currentPage} / {pageCount}</span><button disabled={currentPage >= pageCount} onClick={() => setPage(currentPage + 1)}>Вперёд</button></div>
            </div>
          </>
        )}
      </div>
      <footer className="page-footer"><span>YouGile Operations Portal <span className="footer-version">{PORTAL_VERSION}</span></span><span>Обновление списка при открытии страницы · кэш API 30 секунд</span></footer>
    </section>
  );
}

export function AssignmentPage({
  sites,
  loadState,
  avrSites,
  avrLoadState,
  onComplete,
  pointMode = false
}: {
  sites: PlannedSite[];
  loadState: SiteLoadState;
  avrSites: AvrSitesList | null;
  avrLoadState: SiteLoadState;
  onComplete: () => void;
  pointMode?: boolean;
}) {
  const [users, setUsers] = useState<AssignmentUser[]>([]);
  const [pointAvrSites, setPointAvrSites] = useState<AvrSitesList | null>(null);
  const [pointAvrState, setPointAvrState] = useState<SiteLoadState>("loading");
  const [usersState, setUsersState] = useState<SiteLoadState>("loading");
  const [usersError, setUsersError] = useState("");
  const [selectedTaskIds, setSelectedTaskIds] = useState<string[]>([]);
  const [targetUserId, setTargetUserId] = useState("");
  const [userQuery, setUserQuery] = useState("");
  const [comment, setComment] = useState("");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [preview, setPreview] = useState<AssignmentPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [operationId, setOperationId] = useState("");
  const [operation, setOperation] = useState<AssignmentOperation | null>(null);
  const [operationError, setOperationError] = useState("");
  const pageSize = 25;
  const previewStepRef = useRef<HTMLDivElement>(null);
  const operationStepRef = useRef<HTMLDivElement>(null);
  const stepKey = operationId ? "operation" : preview ? "preview" : null;
  const stepRef = stepKey === "operation" ? operationStepRef : previewStepRef;
  useStepScroll(stepKey, stepRef);

  useEffect(() => {
    if (!pointMode) return;
    const controller = new AbortController();
    let retry: ReturnType<typeof setTimeout> | undefined;
    let active = true;
    const loadAvrSites = async () => {
      try {
        const response = await apiFetch("/api/sites/in-avr", { signal: controller.signal });
        const data = await response.json() as AvrSitesList & { paused?: boolean; error?: string };
        if (!response.ok) throw new Error(data.error ?? "Не удалось загрузить площадки АВР.");
        if (!active) return;
        setPointAvrSites(data);
        setPointAvrState("ready");
        if (data.paused) retry = setTimeout(() => void loadAvrSites(), pausedSitesRetryMs);
      } catch {
        if (!active || controller.signal.aborted) return;
        setPointAvrState("error");
      }
    };
    void loadAvrSites();
    return () => {
      active = false;
      controller.abort();
      if (retry) clearTimeout(retry);
    };
  }, [pointMode]);

  useEffect(() => {
    const controller = new AbortController();
    apiFetch("/api/users", { signal: controller.signal }).then(async (response) => {
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Не удалось загрузить сотрудников.");
      return data as { items: AssignmentUser[] };
    }).then((userData) => {
      setUsers(userData.items);
      setUsersState("ready");
    }).catch((error: unknown) => {
      if (controller.signal.aborted) return;
      setUsersError(error instanceof Error ? error.message : "Не удалось загрузить данные.");
      setUsersState("error");
    });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (!operationId) return;
    let active = true;
    let timeout: ReturnType<typeof setTimeout>;

    const poll = async () => {
      try {
        const response = await apiFetch(`/api/operations/${encodeURIComponent(operationId)}`);
        const data = await response.json() as AssignmentOperation & { error?: string };
        if (!response.ok) throw new Error(data.error ?? "Не удалось получить статус операции.");
        if (!active) return;
        setOperation(data);
        if (data.status === "SUCCEEDED" || data.status === "PARTIAL" || data.status === "FAILED") {
          onComplete();
          return;
        }
        timeout = setTimeout(poll, 1200);
      } catch (error) {
        if (!active) return;
        setOperationError(error instanceof Error ? error.message : "Не удалось получить статус операции.");
        timeout = setTimeout(poll, 2500);
      }
    };

    void poll();
    return () => {
      active = false;
      clearTimeout(timeout);
    };
  }, [operationId, onComplete]);

  const selectableSites = useMemo(() => {
    if (!pointMode) return sites;
    const byTaskId = new Map<string, PlannedSite & { sourceLabel?: string }>();
    for (const site of sites) byTaskId.set(site.taskId, { ...site, sourceLabel: "План" });
    for (const site of [...(avrSites?.items ?? []), ...(pointAvrSites?.items ?? [])]) {
      if (!byTaskId.has(site.taskId)) byTaskId.set(site.taskId, { ...site, sourceLabel: site.columnName });
    }
    return [...byTaskId.values()].sort((left, right) =>
      compareSiteNumbers(left.siteNumber, right.siteNumber) || left.title.localeCompare(right.title, "ru")
    );
  }, [pointMode, sites, avrSites, pointAvrSites]);
  const filteredSites = selectableSites.filter((site) =>
    `${site.siteNumber} ${site.title}`.toLocaleLowerCase("ru").includes(query.trim().toLocaleLowerCase("ru"))
  );
  const pageCount = Math.max(1, Math.ceil(filteredSites.length / pageSize));
  const currentPage = Math.min(page, pageCount);
  const visibleSites = filteredSites.slice((currentPage - 1) * pageSize, currentPage * pageSize);
  const userNameById = new Map(users.map((user) => [user.id, user.name]));
  const alreadyAssignedCount = preview?.items.filter((item) => item.alreadyAssigned).length ?? 0;
  const operationPending = operationId !== "" && (!operation || operation.status === "QUEUED" || operation.status === "RUNNING");

  const updateSelection = (taskId: string, checked: boolean) => {
    setSelectedTaskIds((current) => {
      if (checked) return pointMode ? [taskId] : current.includes(taskId) ? current : [...current, taskId];
      return current.filter((id) => id !== taskId);
    });
    setPreview(null);
    setNotice("");
  };

  const previewChanges = async () => {
    setBusy(true);
    setNotice("");
    setPreview(null);
    try {
      const response = await apiFetch("/api/assignments/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ taskIds: selectedTaskIds, userId: targetUserId })
      });
      const data = await response.json() as AssignmentPreview & { error?: string };
      if (!response.ok) throw new Error(data.error ?? "Не удалось проверить назначения.");
      setPreview(data);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Не удалось проверить назначения.");
    } finally {
      setBusy(false);
    }
  };

  const confirmAssignment = async () => {
    if (!preview) return;
    setBusy(true);
    setNotice("");
    setOperationError("");
    setOperation(null);
    try {
      const response = await apiFetch("/api/assignments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          taskIds: preview.items.map((item) => item.taskId),
          userId: preview.user.id,
          comment: pointMode ? comment : undefined,
          pointAssignmentNotice: pointMode
        })
      });
      const data = await response.json() as { operationId?: string; error?: string };
      if (!response.ok) throw new Error(data.error ?? "Не удалось запустить назначение.");
      if (!data.operationId) throw new Error("Сервер не вернул номер операции.");
      setOperationId(data.operationId);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Не удалось запустить назначение.");
    } finally {
      setBusy(false);
    }
  };

  const resetAssignment = () => {
    setSelectedTaskIds([]);
    setTargetUserId("");
    setUserQuery("");
    setComment("");
    setPreview(null);
    setOperationId("");
    setOperation(null);
    setOperationError("");
    setNotice("");
  };

  return (
    <section className="section-view assignment-page">
      <div className="eyebrow"><span className="eyebrow-line" /> ИЗМЕНЕНИЯ ПРИМЕНЯЮТСЯ ТОЛЬКО ПОСЛЕ ПОДТВЕРЖДЕНИЯ</div>
      <div className="sites-page-heading">
        <div><h1>{pointMode ? "Точечное назначение инженера" : "Массовое назначение инженеров"}</h1><p>{pointMode ? "Введите ФИО инженера, выберите одну площадку и напишите комментарий." : "Выберите инженера и площадки. Перед записью сверим текущих ответственных в YouGile."}</p></div>
        <span className="sites-total">{selectedTaskIds.length.toLocaleString("ru-RU")} выбрано</span>
      </div>

      {usersError && <div className="assignment-error">{usersError}</div>}

      <div className="assignment-layout">
        <div className="panel assignment-sites-panel">
          <div className="assignment-panel-heading">
            <div><h2>1. {pointMode ? "Выберите площадку" : "Выберите площадки"}</h2><p>План напрямую загружен из колонки YouGile.</p></div>
            {selectedTaskIds.length > 0 && <button className="text-button" onClick={() => { setSelectedTaskIds([]); setPreview(null); }}>Сбросить</button>}
          </div>
          <label className="sites-search assignment-search"><Search size={15} /><input value={query} onChange={(event) => { setQuery(event.target.value); setPage(1); setPreview(null); }} placeholder="Поиск по номеру или адресу" /></label>
          {pointMode && (pointAvrState === "error" || avrLoadState === "error") && !pointAvrSites && !avrSites && <div className="sites-page-message sites-message-error">Не удалось загрузить площадки АВР. Сейчас доступны только площадки из плана.</div>}
          {pointMode && pointAvrState === "loading" && avrLoadState === "loading" && <div className="sites-page-message">Загружаем площадки АВР…</div>}
          {loadState === "loading" ? <div className="sites-page-message">Загружаем план…</div> :
            loadState === "error" ? <div className="sites-page-message sites-message-error">Не удалось загрузить план. Вернитесь к разделу «Площадки» и проверьте соединение.</div> :
              filteredSites.length === 0 ? <div className="sites-page-message">Площадки не найдены.</div> : (
                <>
                  <div className="assignment-sites-list">
                    {visibleSites.map((site) => {
                      const checked = selectedTaskIds.includes(site.taskId);
                      return (
                        <label className={`assignment-site-option ${checked ? "assignment-site-selected" : ""}`} key={site.taskId}>
                          <input type={pointMode ? "radio" : "checkbox"} name={pointMode ? "point-site" : undefined} checked={checked} onChange={(event) => updateSelection(site.taskId, event.target.checked)} />
                          <span className="site-number">{site.siteNumber}</span>
                          <span className="site-title" title={site.title}>{site.title}</span>
                          {"sourceLabel" in site && typeof site.sourceLabel === "string" && <span className="site-source-label">{site.sourceLabel}</span>}
                          <span className="site-assignees">{site.assignedCount} назн.</span>
                        </label>
                      );
                    })}
                  </div>
                  <div className="sites-pagination assignment-pagination">
                    <span>Показано {(currentPage - 1) * pageSize + 1}–{Math.min(currentPage * pageSize, filteredSites.length)} из {filteredSites.length.toLocaleString("ru-RU")}</span>
                    <div><button disabled={currentPage <= 1} onClick={() => setPage(currentPage - 1)}>Назад</button><span>{currentPage} / {pageCount}</span><button disabled={currentPage >= pageCount} onClick={() => setPage(currentPage + 1)}>Вперёд</button></div>
                  </div>
                </>
              )}
        </div>

        <div className="assignment-controls">
          <div className="panel assignment-step-panel">
            <div className="assignment-panel-heading"><div><h2>2. Выберите инженера</h2><p>Сотрудник получит доступ к выбранным задачам.</p></div></div>
            {usersState === "loading" ? <div className="assignment-loading">Загружаем сотрудников YouGile…</div> :
              usersState === "error" ? <div className="assignment-error">{usersError}</div> : (
                <label className="field-label">Инженер
                  {pointMode ? <><input list="point-assignment-users" value={userQuery} placeholder="Начните вводить ФИО" onChange={(event) => {
                    const value = event.target.value;
                    setUserQuery(value); setPreview(null); setNotice("");
                    const match = users.find((user) => user.name.toLocaleLowerCase("ru") === value.trim().toLocaleLowerCase("ru"));
                    setTargetUserId(match?.id ?? "");
                  }} /><datalist id="point-assignment-users">{users.map((user) => <option key={user.id} value={user.name} />)}</datalist></> : <select value={targetUserId} onChange={(event) => { setTargetUserId(event.target.value); setPreview(null); setNotice(""); }}><option value="">Выберите сотрудника</option>{users.map((user) => <option key={user.id} value={user.id}>{user.name}{user.status === "offline" ? " · не в сети" : ""}</option>)}</select>}
                </label>
              )}
            {pointMode && <label className="field-label">Комментарий к назначению<textarea rows={4} maxLength={4000} value={comment} placeholder="Напишите комментарий, который появится в чате задачи" onChange={(event) => { setComment(event.target.value); setPreview(null); }} /></label>}
            <button className="btn-primary assignment-preview-button" disabled={busy || selectedTaskIds.length === 0 || !targetUserId || (pointMode && !comment.trim()) || usersState !== "ready" || loadState !== "ready"} onClick={() => void previewChanges()}>
              {busy ? "Проверяем…" : <><ShieldCheck size={16} /> Проверить изменения</>}
            </button>
            {notice && <div className="assignment-error">{notice}</div>}
          </div>

          {preview && (
            <div className="panel assignment-preview-panel" ref={previewStepRef}>
              <div className="assignment-panel-heading"><div><h2>3. Предпросмотр</h2><p>{preview.user.name} · {countRu(preview.items.length, siteForms)}</p></div><span className="preview-valid-label"><CheckCircle2 size={14} /> Проверено</span></div>
              <div className="preview-summary">Будет добавлен новый ответственный. Текущие инженеры останутся назначенными.</div>
              {pointMode && <div className="preview-summary">Комментарий в чат: {comment}</div>}
              <div className="assignment-preview-list">
                {preview.items.map((item) => (
                  <div className="assignment-preview-row" key={item.taskId}>
                    <span className="site-number">{item.siteNumber}</span>
                    <span className="site-title" title={item.title}>{item.title}</span>
                    <span className={item.alreadyAssigned ? "preview-already" : "preview-add"}>
                      {item.alreadyAssigned ? "Уже назначен" : `+ ${preview.user.name}`}
                    </span>
                    <small title={item.currentUserIds.map((id) => userNameById.get(id) ?? id).join(", ")}>
                      Сейчас: {item.currentUserIds.map((id) => userNameById.get(id) ?? id).join(", ") || "нет ответственных"}
                    </small>
                  </div>
                ))}
              </div>
              {alreadyAssignedCount === preview.items.length ? (
                <div className="assignment-result-info">Этот инженер уже назначен на все выбранные площадки — изменений не требуется.</div>
              ) : (
                <>
                  <button className="btn-primary assignment-confirm-button" disabled={busy || operationPending} onClick={() => void confirmAssignment()}>
                    <CheckCircle2 size={16} /> {busy ? "Запускаем…" : "Подтвердить и назначить"}
                  </button>
                </>
              )}
            </div>
          )}
        </div>
      </div>

      {operationId && (
        <div className={`panel assignment-operation ${operation && ["SUCCEEDED", "PARTIAL", "FAILED"].includes(operation.status) ? "assignment-operation-done" : ""}`} ref={operationStepRef}>
          <div className="assignment-panel-heading">
            <div><h2>{operation?.status === "SUCCEEDED" ? "Назначение завершено" : operation?.status === "PARTIAL" || operation?.status === "FAILED" ? "Результат операции" : "Выполняем назначение"}</h2><p>{operation?.message ?? "Задание добавлено в очередь YouGile."}</p></div>
            {operation && <span className="sites-total">{operation.completed} / {operation.total}</span>}
          </div>
          {operationPending && <div className="operation-progress"><span style={{ transform: `scaleX(${operation && operation.total > 0 ? operation.completed / operation.total : 0.02})` }} /></div>}
          {operationError && <p className="assignment-error">{operationError}</p>}
          {operation && operation.failed > 0 && <div className="operation-failures">{operation.items.filter((item) => item.status === "FAILED").map((item) => <p key={item.siteId}>Площадка {item.siteId}: {item.errorMessage}</p>)}</div>}
          {(Boolean(operationError) || Boolean(operation && (operation.failed > 0 || operation.errorDetails || ["FAILED", "PARTIAL"].includes(operation.status)))) && (
            <ErrorDiagnostics payload={operationDiagnosticsPayload({ action: "Назначение инженера вручную", operation, apiError: operationError || null })} />
          )}
          {operation && ["SUCCEEDED", "PARTIAL", "FAILED"].includes(operation.status) && <button className="outline-button assignment-new-button" onClick={resetAssignment}><RefreshCw size={14} /> Новое назначение</button>}
        </div>
      )}
      <footer className="page-footer"><span>YouGile Operations Portal <span className="footer-version">{PORTAL_VERSION}</span></span><span>Операции журналируются · обрабатываются последовательно</span></footer>
    </section>
  );
}

function SectionPage({ section, health }: { section: Exclude<Section, "Управление работами в YouGile" | "DAPS" | "Netbox" | "Ежедневный отчет по KPI" | "Согласование/Оповещение" | "Согласование АВР" | "Настройки согласования" | "Планирование Работ" | "Площадки" | "Площадки АВР" | "Массовое назначение инженеров" | "Точечное назначение инженера" | "Снять инженеров" | "Написать комментарий" | "Проверить работы" | "История" | "Настройки" | "Учётные записи" | "Логирование" | "Конфигурация портала">; health: Health }) {
  const content = {
    "Снять инженеров": {
      icon: UsersRound,
      title: "Массовое снятие с площадки",
      description: "Выберите XLSX-файл и проверьте назначения перед снятием инженеров с площадок.",
      points: ["Источник — загруженный или сохранённый XLSX", "Предпросмотр текущих и оставшихся ответственных", "Снятие только инженеров из выбранных строк"]
    },
    Аудит: {
      icon: ClipboardCheck,
      title: "Проверка назначений",
      description: "Сверяйте план работ с ответственными в YouGile и находите расхождения до начала работ.",
      points: ["Сверка ID площадок и задач", "Проверка назначенных пользователей", "Отчёт с причинами расхождений"]
    },
    "Управление работами в YouGile": {
      icon: LayoutDashboard,
      title: "Управление работами в YouGile",
      description: "",
      points: []
    }
  }[section];
  const Icon = content.icon;

  return (
    <section className="section-view">
      <div className="eyebrow"><span className="eyebrow-line" /> РАБОЧЕЕ ПРОСТРАНСТВО</div>
      <div className="section-hero">
        <span className="section-hero-icon"><Icon size={22} /></span>
        <div><h1>{content.title}</h1><p>{content.description}</p></div>
      </div>
      <div className="section-columns">
        <div className="panel section-panel">
          <div className="panel-heading"><div><h2>Возможности раздела</h2><p>Планируемый функционал после переноса сценариев</p></div></div>
          <ul className="feature-list">{content.points.map((point) => <li key={point}><span><Check size={13} /></span>{point}</li>)}</ul>
          <div className="section-notice"><Activity size={17} /><span>{health === "ok" ? "API доступно. Бизнес-сценарии ещё не перенесены из n8n." : "Для работы раздела нужно подключить API и перенести сценарии из n8n."}</span></div>
        </div>
        <div className="panel migration-panel">
          <span className="migration-icon"><FileSpreadsheet size={19} /></span>
          <h2>Безопасный перенос</h2>
          <p>Сначала данные и интеграции. Затем предпросмотр и только после подтверждения — запись изменений в YouGile.</p>
          <div className="migration-step"><span>1</span> Подключить справочники <span className="migration-state">В ПЛАНЕ</span></div>
          <div className="migration-step"><span>2</span> Реализовать API сценария <span className="migration-state">В ПЛАНЕ</span></div>
          <div className="migration-step"><span>3</span> Приёмка на тестовых данных <span className="migration-state">В ПЛАНЕ</span></div>
        </div>
      </div>
      <footer className="page-footer"><span>YouGile Operations Portal <span className="footer-version">{PORTAL_VERSION}</span></span><span><ShieldCheck size={14} /> План предусматривает подтверждение перед записью</span></footer>
    </section>
  );
}

export default App;
