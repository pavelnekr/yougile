import { useCallback, useEffect, useRef, useState } from "react";
import {
  Activity,
  ArrowDownToLine,
  ArrowRight,
  ArrowUpRight,
  Bell,
  Check,
  ChevronDown,
  ClipboardCheck,
  Clock3,
  CheckCircle2,
  FileSpreadsheet,
  History,
  LayoutDashboard,
  LogOut,
  Menu,
  MessageSquarePlus,
  RefreshCw,
  Search,
  Settings2,
  ShieldCheck,
  UsersRound
} from "lucide-react";
import XlsxAssignmentPage from "./XlsxAssignmentPage.js";
import CommentTemplatesPage from "./CommentTemplatesPage.js";
import ImportAuditPage from "./ImportAuditPage.js";
import XlsxRemovalPage from "./XlsxRemovalPage.js";
import CommentPage from "./CommentPage.js";
import XlsxWorkCheckPage from "./XlsxWorkCheckPage.js";
import HistoryPage from "./HistoryPage.js";
import LoginPage, { type PortalUser } from "./LoginPage.js";
import { apiFetch, onSessionExpired } from "./apiClient.js";
import { useStepScroll } from "./useStepScroll.js";

type Section = "Обзор" | "Площадки" | "Назначить инженера" | "Снять инженеров" | "Написать комментарий" | "Проверить работы" | "Аудит" | "История" | "Настройки";
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
  items: { siteId: string; status: string; errorMessage: string | null }[];
};
type WorkTypeStatistic = {
  month: string;
  total: number;
  unclassified: number;
  items: { type: "filter" | "balancers" | "bypasses" | "ehw"; label: string; count: number }[];
};

const navigation: { label: Section; icon: typeof LayoutDashboard }[] = [
  { label: "Обзор", icon: LayoutDashboard },
  { label: "Аудит", icon: ClipboardCheck },
  { label: "История", icon: History },
  { label: "Настройки", icon: Settings2 }
];

const actions = [
  {
    number: "01",
    title: "Назначить инженера",
    description: "Выберите площадки и инженера, проверьте план изменений и подтвердите назначение.",
    icon: ArrowUpRight,
    tone: "blue",
    section: "Назначить инженера" as Section
  },
  {
    number: "02",
    title: "Снять с площадки",
    description: "Загрузите XLSX или выберите файл из аудита, чтобы проверить назначения для снятия.",
    icon: ArrowDownToLine,
    tone: "violet",
    section: "Снять инженеров" as Section
  },
  {
    number: "03",
    title: "Проверить работы",
    description: "Загрузите XLSX или выберите файл из аудита, чтобы посмотреть последние комментарии по площадкам.",
    icon: ClipboardCheck,
    tone: "green",
    section: "Проверить работы" as Section
  },
  {
    number: "04",
    title: "Написать комментарий",
    description: "Выберите одну или несколько площадок и напишите комментарий в чат задач YouGile.",
    icon: MessageSquarePlus,
    tone: "orange",
    section: "Написать комментарий" as Section
  }
];

function App() {
  const [sessionUser, setSessionUser] = useState<PortalUser | null>(null);
  // null = проверяем, false = гость, true = вход выполнен.
  const [sessionChecked, setSessionChecked] = useState(false);
  const [section, setSection] = useState<Section>("Обзор");
  const [health, setHealth] = useState<Health>("loading");
  const [sites, setSites] = useState<PlannedSite[]>([]);
  const [siteLoadState, setSiteLoadState] = useState<SiteLoadState>("loading");
  const [siteError, setSiteError] = useState("");
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [siteRefreshKey, setSiteRefreshKey] = useState(0);
  const refreshSites = useCallback(() => setSiteRefreshKey((key) => key + 1), []);

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
  useEffect(() => onSessionExpired(() => {
    setSessionUser(null);
    setSection("Обзор");
  }), []);

  const signOut = useCallback(async () => {
    try {
      await apiFetch("/api/auth/logout", { method: "POST" });
    } finally {
      // Выход делаем и при ошибке сети: локально всё равно показываем форму входа.
      setSessionUser(null);
      setSection("Обзор");
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    apiFetch("/api/health", { signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error("Backend недоступен");
        return response.json();
      })
      .then((data: { status?: string }) => setHealth(data.status === "ok" ? "ok" : "error"))
      .catch(() => {
        if (!controller.signal.aborted) setHealth("error");
      });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    apiFetch("/api/sites/in-plan", { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) {
          const error = await response.json().catch(() => null) as { error?: string } | null;
          throw new Error(error?.error ?? "Не удалось загрузить площадки.");
        }
        return response.json() as Promise<{ items: PlannedSite[] }>;
      })
      .then((data) => {
        setSites(data.items);
        setSiteLoadState("ready");
        setSiteError("");
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setSiteError(error instanceof Error ? error.message : "Не удалось загрузить площадки.");
        setSiteLoadState("error");
      });

    return () => controller.abort();
  }, [siteRefreshKey]);

  const chooseSection = (label: Section) => {
    setSection(label);
    setMobileNavOpen(false);
  };

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
      <aside className={`sidebar ${mobileNavOpen ? "sidebar-open" : ""}`}>
        <a className="brand" href="#" onClick={(event) => { event.preventDefault(); chooseSection("Обзор"); }}>
          <span className="brand-mark"><span /><span /><span /><span /></span>
          <span className="brand-copy"><strong>yougile</strong><small>OPERATIONS PORTAL</small></span>
        </a>

        <div className="workspace-switch">
          <span className="workspace-avatar">D</span>
          <span className="workspace-copy"><strong>Команда YouGile</strong><small>Рабочее пространство</small></span>
          <ChevronDown size={15} />
        </div>

        <p className="nav-caption">РАБОЧЕЕ ПРОСТРАНСТВО</p>
        <nav className="navigation" aria-label="Основная навигация">
          {navigation.map(({ label, icon: Icon }) => (
            <button key={label} className={`nav-link ${section === label ? "nav-link-active" : ""}`} onClick={() => chooseSection(label)}>
              <Icon size={18} strokeWidth={1.8} />
              <span>{label}</span>
            </button>
          ))}
        </nav>

        <div className="sidebar-bottom">
          <div className="help-card">
            <span className="help-icon"><ShieldCheck size={17} /></span>
            <strong>Изменения под контролем</strong>
            <p>Перед записью будет доступна проверка плана.</p>
          </div>
          <button className="profile" type="button" onClick={() => void signOut()} title="Выйти из портала">
            <span className="profile-avatar">{sessionUser.displayName.slice(0, 1).toLocaleUpperCase("ru")}</span>
            <span className="profile-copy"><strong>{sessionUser.displayName}</strong><small>{sessionUser.login} · выход</small></span>
            <LogOut size={15} />
          </button>
        </div>
      </aside>

      <main className="main-area">
        <header className="topbar">
          <button className="icon-button mobile-menu" aria-label="Открыть меню" onClick={() => setMobileNavOpen(true)}><Menu size={19} /></button>
          <div className="breadcrumbs"><span>Портал операций</span><span className="crumb-separator">/</span><strong>{section}</strong></div>
          <div className="topbar-actions">
            <div className={`service-status status-${health}`}><span className="status-dot" />{health === "ok" ? "API и сервисы доступны" : health === "loading" ? "Проверка API" : "API не подключён"}</div>
            <button className="icon-button search-button" aria-label="Поиск"><Search size={18} /></button>
            <button className="icon-button notification-button" aria-label="Уведомления"><Bell size={18} /><i /></button>
            <span className="topbar-avatar">{sessionUser.displayName.slice(0, 1).toLocaleUpperCase("ru")}</span>
          </div>
        </header>

        <div className="page-content">
          {section === "Обзор" ? (
            <Overview onNavigate={chooseSection} health={health} sites={sites} siteLoadState={siteLoadState} siteError={siteError} />
          ) : section === "Площадки" ? (
            <SitesPage sites={sites} loadState={siteLoadState} error={siteError} />
          ) : section === "Назначить инженера" ? (
            <XlsxAssignmentPage onComplete={refreshSites} />
          ) : section === "Снять инженеров" ? (
            <XlsxRemovalPage onComplete={refreshSites} />
          ) : section === "Написать комментарий" ? (
            <CommentPage
              sites={sites}
              loadState={siteLoadState}
              siteError={siteError}
              onComplete={refreshSites}
              onOpenHistory={() => chooseSection("История")}
            />
          ) : section === "Проверить работы" ? (
            <XlsxWorkCheckPage />
          ) : section === "Настройки" ? (
            <CommentTemplatesPage />
          ) : section === "Аудит" ? (
            <ImportAuditPage />
          ) : section === "История" ? (
            <HistoryPage />
          ) : (
            <SectionPage section={section} health={health} />
          )}
        </div>
      </main>
    </div>
  );
}

function Overview({
  onNavigate,
  health,
  sites,
  siteLoadState,
  siteError
}: {
  onNavigate: (section: Section) => void;
  health: Health;
  sites: PlannedSite[];
  siteLoadState: SiteLoadState;
  siteError: string;
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

      <section className="stats-grid" aria-label="Сводка">
        <StatCard
          title="Площадки в фильтрации"
          value={siteLoadState === "ready" ? sites.length.toLocaleString("ru-RU") : "—"}
          foot={siteLoadState === "ready" ? "Активные задачи в колонке плана YouGile" : siteLoadState === "error" ? "Не удалось загрузить данные" : "Загрузка списка из YouGile"}
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

      <section className="bottom-grid">
        <div className="panel activity-panel planned-sites-preview">
          <div className="panel-heading"><div><h2>Площадки в фильтрации</h2><p>{siteLoadState === "ready" ? `${sites.length.toLocaleString("ru-RU")} активных задач из YouGile` : "Актуальный список из YouGile"}</p></div><button className="text-button" onClick={() => onNavigate("Площадки")}>Все площадки <ArrowRight size={14} /></button></div>
          {siteLoadState === "loading" ? (
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
        <div className="panel checklist-panel">
          <div className="panel-heading"><div><h2>Этапы переноса</h2><p>Текущий статус проекта</p></div><span className="checklist-count">2 / 3</span></div>
          <div className="checklist-item"><span className="checklist-done"><Check size={12} /></span><span><strong>Интеграция YouGile подключена</strong><small>Список задач и сотрудников загружается</small></span><span className="check-status check-status-done">ГОТОВО</span></div>
          <div className="checklist-item"><span className="checklist-done"><Check size={12} /></span><span><strong>Назначения по плану XLSX</strong><small>Загрузка, сопоставление и подтверждение</small></span><span className="check-status check-status-done">ГОТОВО</span></div>
          <div className="checklist-item"><span className="checklist-empty"><Check size={12} /></span><span><strong>Личные учётные записи</strong><small>Нужны для безопасного доступа команды</small></span><span className="check-status">ДАЛЬШЕ</span></div>
        </div>
      </section>

      <footer className="page-footer"><span>YouGile Operations Portal <span className="footer-version">v0.1</span></span><span>Портал управления операциями</span></footer>
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

function SiteRow({ site }: { site: PlannedSite }) {
  return (
    <div className="site-row">
      <span className="site-number">{site.siteNumber}</span>
      <span className="site-title" title={site.title}>{site.title}</span>
      <span className={`site-status ${site.completed ? "site-status-complete" : ""}`}>{site.completed ? "Выполнена" : "В плане"}</span>
    </div>
  );
}

function SitesPage({ sites, loadState, error }: { sites: PlannedSite[]; loadState: SiteLoadState; error: string }) {
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
        <div><h1>Площадки в плане</h1><p>Активные задачи из колонки плана в YouGile.</p></div>
        <span className="sites-total">{loadState === "ready" ? `${sites.length.toLocaleString("ru-RU")} площадок` : "Загрузка…"}</span>
      </div>
      <div className="panel sites-table-panel">
        <div className="sites-toolbar">
          <div><strong>Список площадок</strong><span>{loadState === "ready" ? `Найдено: ${filteredSites.length.toLocaleString("ru-RU")}` : "Источник: YouGile"}</span></div>
          <label className="sites-search"><Search size={15} /><input value={query} onChange={(event) => { setQuery(event.target.value); setPage(1); }} placeholder="Поиск по номеру или адресу" /></label>
        </div>
        {loadState === "loading" ? (
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
      <footer className="page-footer"><span>YouGile Operations Portal <span className="footer-version">v0.1</span></span><span>Обновление списка при открытии страницы · кэш API 30 секунд</span></footer>
    </section>
  );
}

export function AssignmentPage({
  sites,
  loadState,
  onComplete
}: {
  sites: PlannedSite[];
  loadState: SiteLoadState;
  onComplete: () => void;
}) {
  const [users, setUsers] = useState<AssignmentUser[]>([]);
  const [usersState, setUsersState] = useState<SiteLoadState>("loading");
  const [usersError, setUsersError] = useState("");
  const [selectedTaskIds, setSelectedTaskIds] = useState<string[]>([]);
  const [targetUserId, setTargetUserId] = useState("");
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

  const filteredSites = sites.filter((site) =>
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
      if (checked) return current.includes(taskId) ? current : [...current, taskId];
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
          userId: preview.user.id
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
        <div><h1>Назначить инженера</h1><p>Выберите инженера и площадки. Перед записью сверим текущих ответственных в YouGile.</p></div>
        <span className="sites-total">{selectedTaskIds.length.toLocaleString("ru-RU")} выбрано</span>
      </div>

      {usersError && <div className="assignment-error">{usersError}</div>}

      <div className="assignment-layout">
        <div className="panel assignment-sites-panel">
          <div className="assignment-panel-heading">
            <div><h2>1. Выберите площадки</h2><p>План напрямую загружен из колонки YouGile.</p></div>
            {selectedTaskIds.length > 0 && <button className="text-button" onClick={() => { setSelectedTaskIds([]); setPreview(null); }}>Сбросить</button>}
          </div>
          <label className="sites-search assignment-search"><Search size={15} /><input value={query} onChange={(event) => { setQuery(event.target.value); setPage(1); setPreview(null); }} placeholder="Поиск по номеру или адресу" /></label>
          {loadState === "loading" ? <div className="sites-page-message">Загружаем план…</div> :
            loadState === "error" ? <div className="sites-page-message sites-message-error">Не удалось загрузить план. Вернитесь к разделу «Площадки» и проверьте соединение.</div> :
              filteredSites.length === 0 ? <div className="sites-page-message">Площадки не найдены.</div> : (
                <>
                  <div className="assignment-sites-list">
                    {visibleSites.map((site) => {
                      const checked = selectedTaskIds.includes(site.taskId);
                      return (
                        <label className={`assignment-site-option ${checked ? "assignment-site-selected" : ""}`} key={site.taskId}>
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={(event) => updateSelection(site.taskId, event.target.checked)}
                          />
                          <span className="site-number">{site.siteNumber}</span>
                          <span className="site-title" title={site.title}>{site.title}</span>
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
                  <select value={targetUserId} onChange={(event) => { setTargetUserId(event.target.value); setPreview(null); setNotice(""); }}>
                    <option value="">Выберите сотрудника</option>
                    {users.map((user) => <option key={user.id} value={user.id}>{user.name}{user.status === "offline" ? " · не в сети" : ""}</option>)}
                  </select>
                </label>
              )}
            <button className="btn-primary assignment-preview-button" disabled={busy || selectedTaskIds.length === 0 || !targetUserId || usersState !== "ready" || loadState !== "ready"} onClick={() => void previewChanges()}>
              {busy ? "Проверяем…" : <><ShieldCheck size={16} /> Проверить изменения</>}
            </button>
            {notice && <div className="assignment-error">{notice}</div>}
          </div>

          {preview && (
            <div className="panel assignment-preview-panel" ref={previewStepRef}>
              <div className="assignment-panel-heading"><div><h2>3. Предпросмотр</h2><p>{preview.user.name} · {preview.items.length} площадок</p></div><span className="preview-valid-label"><CheckCircle2 size={14} /> Проверено</span></div>
              <div className="preview-summary">Будет добавлен новый ответственный. Текущие инженеры останутся назначенными.</div>
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
          {operationPending && <div className="operation-progress"><span style={{ width: `${operation ? Math.round(operation.completed / operation.total * 100) : 2}%` }} /></div>}
          {operationError && <p className="assignment-error">{operationError}</p>}
          {operation && operation.failed > 0 && <div className="operation-failures">{operation.items.filter((item) => item.status === "FAILED").map((item) => <p key={item.siteId}>Площадка {item.siteId}: {item.errorMessage}</p>)}</div>}
          {operation && ["SUCCEEDED", "PARTIAL", "FAILED"].includes(operation.status) && <button className="outline-button assignment-new-button" onClick={resetAssignment}><RefreshCw size={14} /> Новое назначение</button>}
        </div>
      )}
      <footer className="page-footer"><span>YouGile Operations Portal <span className="footer-version">v0.1</span></span><span>Операции журналируются · обрабатываются последовательно</span></footer>
    </section>
  );
}

function SectionPage({ section, health }: { section: Exclude<Section, "Обзор" | "Площадки" | "Назначить инженера" | "Снять инженеров" | "Написать комментарий" | "Проверить работы" | "История" | "Настройки">; health: Health }) {
  const content = {
    "Снять инженеров": {
      icon: UsersRound,
      title: "Снять инженеров",
      description: "Выберите XLSX-файл и проверьте назначения перед снятием инженеров с площадок.",
      points: ["Источник — загруженный или сохранённый XLSX", "Предпросмотр текущих и оставшихся ответственных", "Снятие только инженеров из выбранных строк"]
    },
    Аудит: {
      icon: ClipboardCheck,
      title: "Проверка назначений",
      description: "Сверяйте план работ с ответственными в YouGile и находите расхождения до начала работ.",
      points: ["Сверка ID площадок и задач", "Проверка назначенных пользователей", "Отчёт с причинами расхождений"]
    },
    Обзор: {
      icon: LayoutDashboard,
      title: "Обзор",
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
      <footer className="page-footer"><span>YouGile Operations Portal <span className="footer-version">v0.1</span></span><span><ShieldCheck size={14} /> План предусматривает подтверждение перед записью</span></footer>
    </section>
  );
}

export default App;
