import { Fragment, useEffect, useRef, useState, type FormEvent } from "react";
import {
  AlertCircle,
  Check,
  ChevronDown,
  ChevronUp,
  Copy,
  LoaderCircle,
  RefreshCw,
  ScrollText,
  Search
} from "lucide-react";
import { apiFetch } from "./apiClient.js";
import { copyText } from "./clipboard.js";
import { countRu, recordForms } from "./plural.js";

/**
 * Раздел «Логирование»: журнал действий портала для роли ADMIN.
 *
 * Строки приходят уже отфильтрованными от секретов — пароли и токены вырезаются
 * на бэкенде до записи (см. apps/api/src/modules/logs/service.ts), поэтому здесь
 * достаточно не показывать лишних колонок.
 */

type LogLevel = "INFO" | "WARN" | "ERROR";

type LogItem = {
  id: string;
  createdAt: string;
  level: LogLevel;
  action: string;
  message: string;
  actorLogin: string | null;
  actorRole: string | null;
  ip: string | null;
  method: string | null;
  path: string | null;
  status: number | null;
  durationMs: number | null;
  request: unknown;
  error: string | null;
  entityId: string | null;
};

type LogFacet = { login: string; count: number };
type ActionFacet = { action: string; count: number };

type LogsResponse = {
  items: LogItem[];
  total: number;
  hasMore: boolean;
  actors: LogFacet[];
  actions: ActionFacet[];
  error?: string;
};

type Filters = {
  level: LogLevel | "";
  actor: string;
  action: string;
  query: string;
};

const levelLabels: Record<LogLevel, string> = {
  INFO: "Информация",
  WARN: "Предупреждение",
  ERROR: "Ошибка"
};

// Пустые значения не попадают в строку запроса: иначе фильтр по пустой строке
// нашёл бы только записи с пустым полем, а не снял бы фильтр.
function buildUrl(filters: Filters, before?: string) {
  const params = new URLSearchParams();
  if (filters.level) params.set("level", filters.level);
  if (filters.actor) params.set("actor", filters.actor);
  if (filters.action) params.set("action", filters.action);
  if (filters.query) params.set("q", filters.query);
  if (before) params.set("before", before);
  const search = params.toString();
  return search ? `/api/logs?${search}` : "/api/logs";
}

function formatDate(value: string) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "—";
  return date.toLocaleDateString("ru-RU", { dateStyle: "short" });
}

function formatTime(value: string) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "—";
  return date.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function formatNumber(value: number) {
  return value.toLocaleString("ru-RU");
}

export default function LogsPage() {
  const [items, setItems] = useState<LogItem[]>([]);
  const [total, setTotal] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [actors, setActors] = useState<LogFacet[]>([]);
  const [actions, setActions] = useState<ActionFacet[]>([]);
  const [level, setLevel] = useState<LogLevel | "">("");
  const [actor, setActor] = useState("");
  const [action, setAction] = useState("");
  const [query, setQuery] = useState("");
  const [appliedQuery, setAppliedQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState("");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  // id записи, содержимое которой только что скопировано (для короткой подписи
  // «Скопировано» на кнопке).
  const [copiedId, setCopiedId] = useState<string | null>(null);
  // Отдельный контроллер на подгрузку: общий (из эффекта) сбрасывается только
  // при смене фильтров, а догрузка живёт своей жизненным циклом.
  const moreController = useRef<AbortController | null>(null);
  const [revision, setRevision] = useState(0);

  const filters: Filters = { level, actor, action, query: appliedQuery };
  const hasFilters = Boolean(level || actor || action || appliedQuery);

  // Копирование записи журнала целиком: оператор вставляет её в сообщение
  // разработчику вместо пересказа. Поля те же, что видны в раскрытой записи.
  const copyEntry = (item: LogItem) => {
    const payload = {
      id: item.id,
      createdAt: item.createdAt,
      level: item.level,
      action: item.action,
      message: item.message,
      actorLogin: item.actorLogin,
      actorRole: item.actorRole,
      ip: item.ip,
      method: item.method,
      path: item.path,
      status: item.status,
      durationMs: item.durationMs,
      request: item.request,
      error: item.error,
      entityId: item.entityId
    };
    void copyText(JSON.stringify(payload, null, 2)).then((ok) => {
      if (!ok) return;
      setCopiedId(item.id);
      setTimeout(() => setCopiedId((current) => (current === item.id ? null : current)), 2000);
    });
  };

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    (async () => {
      try {
        const response = await apiFetch(buildUrl(filters), { signal: controller.signal });
        const data = await response.json() as LogsResponse;
        if (!response.ok) throw new Error(data.error ?? "Не удалось загрузить журнал.");
        setItems(data.items);
        setTotal(data.total);
        setHasMore(data.hasMore);
        setActors(data.actors ?? []);
        setActions(data.actions ?? []);
      } catch (err) {
        if (controller.signal.aborted) return;
        setError(err instanceof Error ? err.message : "Не удалось загрузить журнал.");
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();
    // filters перечитывается на каждом рендере, но меняется только по значению
    // четырёх полей — иначе запрос уходил бы после каждого рендера.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    return () => controller.abort();
  }, [level, actor, action, appliedQuery, revision]);

  useEffect(() => () => moreController.current?.abort(), []);

  const loadMore = async () => {
    const last = items[items.length - 1];
    if (!last || loadingMore) return;

    moreController.current?.abort();
    const controller = new AbortController();
    moreController.current = controller;
    setLoadingMore(true);
    setError("");
    try {
      const response = await apiFetch(buildUrl(filters, last.id), { signal: controller.signal });
      const data = await response.json() as LogsResponse;
      if (!response.ok) throw new Error(data.error ?? "Не удалось загрузить журнал.");
      // Склеиваем по id: пока грузилась страница, в голову могли добавиться
      // новые строки, и дубликат здесь не будет ошибкой, а только помехой.
      setItems((prev) => {
        const known = new Set(prev.map((item) => item.id));
        return [...prev, ...data.items.filter((item) => !known.has(item.id))];
      });
      setHasMore(data.hasMore);
    } catch (err) {
      if (controller.signal.aborted) return;
      setError(err instanceof Error ? err.message : "Не удалось загрузить журнал.");
    } finally {
      if (!controller.signal.aborted) setLoadingMore(false);
    }
  };

  const submitSearch = (event: FormEvent) => {
    event.preventDefault();
    setAppliedQuery(query.trim());
  };

  const resetFilters = () => {
    setLevel("");
    setActor("");
    setAction("");
    setQuery("");
    setAppliedQuery("");
  };

  const toggleDetails = (id: string) => {
    setExpandedId((current) => (current === id ? null : id));
  };

  return (
    <section className="section-view logs-page">
      <div className="eyebrow"><span className="eyebrow-line" /> АДМИНИСТРИРОВАНИЕ ПОРТАЛА</div>

      <div className="section-hero admin-hero">
        <span className="section-hero-icon"><ScrollText size={22} /></span>
        <div>
          <h1>Логирование</h1>
          <p>Что делали сотрудники, какие запросы уходили в API и что из них вернулось с ошибкой.</p>
        </div>
        <div className="admin-hero-actions">
          <button
            className="icon-button"
            aria-label="Обновить"
            onClick={() => setRevision((value) => value + 1)}
            disabled={loading}
          >
            <RefreshCw size={16} />
          </button>
        </div>
      </div>

      {error && (
        <div className="admin-feedback admin-feedback-error" role="alert">
          <AlertCircle size={15} />{error}
        </div>
      )}

      <div className="panel logs-panel">
        <div className="panel-heading">
          <div>
            <h2>Журнал событий</h2>
            <p>
              Записываются действия и ошибки. Успешные чтения данных в журнал не попадают:
              их в день тысячи, и они затопили бы всё остальное.
            </p>
          </div>
          <span className="logs-total">{countRu(total, recordForms)}</span>
        </div>

        <form className="logs-filters" onSubmit={submitSearch}>
          <label className="logs-filter">
            <span>Уровень</span>
            <select value={level} onChange={(event) => setLevel(event.target.value as LogLevel | "")}>
              <option value="">Все уровни</option>
              <option value="ERROR">Ошибка</option>
              <option value="WARN">Предупреждение</option>
              <option value="INFO">Информация</option>
            </select>
          </label>

          <label className="logs-filter">
            <span>Сотрудник</span>
            <select value={actor} onChange={(event) => setActor(event.target.value)}>
              <option value="">Все сотрудники</option>
              {actors.map((item) => (
                <option key={item.login} value={item.login}>
                  {item.login} ({formatNumber(item.count)})
                </option>
              ))}
            </select>
          </label>

          <label className="logs-filter logs-filter-action">
            <span>Действие</span>
            <select value={action} onChange={(event) => setAction(event.target.value)}>
              <option value="">Все действия</option>
              {actions.map((item) => (
                <option key={item.action} value={item.action}>
                  {item.action} ({formatNumber(item.count)})
                </option>
              ))}
            </select>
          </label>

          <label className="logs-search">
            <Search size={14} />
            <input
              type="search"
              value={query}
              placeholder="Текст сообщения, путь или ошибка"
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>

          <button className="btn-primary logs-search-button" type="submit">Найти</button>
          {hasFilters && (
            <button className="outline-button" type="button" onClick={resetFilters}>Сбросить</button>
          )}
        </form>

        {loading && !items.length ? (
          <div className="admin-loading">
            <LoaderCircle size={16} className="template-spinner" /> Загружаем журнал…
          </div>
        ) : !items.length ? (
          <div className="logs-empty">По выбранным условиям записей нет.</div>
        ) : (
          <>
            <div className="logs-table-wrap">
              <table className="logs-table">
                <thead>
                  <tr>
                    <th>Время</th>
                    <th>Уровень</th>
                    <th>Событие</th>
                    <th>Сотрудник</th>
                    <th>Ответ</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((item) => {
                    const expanded = expandedId === item.id;
                    return (
                      <Fragment key={item.id}>
                        <tr className={`logs-row logs-row-${item.level.toLowerCase()}`}>
                          <td className="logs-cell-time">
                            <span title={new Date(item.createdAt).toLocaleString("ru-RU")}>
                              {formatDate(item.createdAt)}
                            </span>
                            <small>{formatTime(item.createdAt)}</small>
                          </td>
                          <td>
                            <span className={`logs-level logs-level-${item.level.toLowerCase()}`}>
                              {levelLabels[item.level]}
                            </span>
                          </td>
                          <td className="logs-cell-event">
                            <button
                              type="button"
                              className="logs-row-toggle"
                              aria-expanded={expanded}
                              onClick={() => toggleDetails(item.id)}
                            >
                              {expanded ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
                              <span>
                                <strong>{item.message}</strong>
                                <small>{item.action}</small>
                              </span>
                            </button>
                          </td>
                          <td className="logs-cell-actor">
                            {item.actorLogin ?? "—"}
                            {item.actorRole && <small>{item.actorRole}</small>}
                          </td>
                          <td className="logs-cell-status">
                            {item.status === null ? "—" : <strong>{item.status}</strong>}
                            <small>{item.durationMs === null ? "—" : `${formatNumber(item.durationMs)} мс`}</small>
                          </td>
                        </tr>
                        {expanded && (
                          <tr className="logs-detail-row">
                            <td colSpan={5}>
                              <div className="logs-detail">
                                <div className="logs-detail-copy">
                                  <button
                                    type="button"
                                    className="text-button"
                                    disabled={copiedId === item.id}
                                    onClick={() => copyEntry(item)}
                                  >
                                    {copiedId === item.id ? <Check size={13} /> : <Copy size={13} />} {copiedId === item.id ? "Скопировано" : "Скопировать запись"}
                                  </button>
                                </div>
                                <div className="logs-detail-grid">
                                  <div>
                                    <span>Действие</span>
                                    <code>{item.action}</code>
                                  </div>
                                  <div>
                                    <span>Путь запроса</span>
                                    <code>{item.method} {item.path}</code>
                                  </div>
                                  <div>
                                    <span>Код ответа</span>
                                    <code>{item.status === null ? "—" : item.status}</code>
                                  </div>
                                  <div>
                                    <span>Длительность</span>
                                    <code>{item.durationMs === null ? "—" : `${formatNumber(item.durationMs)} мс`}</code>
                                  </div>
                                  <div>
                                    <span>Адрес клиента</span>
                                    <code>{item.ip ?? "—"}</code>
                                  </div>
                                  <div>
                                    <span>Исполнитель</span>
                                    <code>{item.actorLogin ?? "—"}{item.actorRole ? ` · ${item.actorRole}` : ""}</code>
                                  </div>
                                </div>

                                {item.error && (
                                  <div className="logs-detail-block">
                                    <span>Что вернулось с ошибкой</span>
                                    <pre>{item.error}</pre>
                                  </div>
                                )}

                                {item.request != null && (
                                  <div className="logs-detail-block">
                                    <span>Тело запроса</span>
                                    <pre>{JSON.stringify(item.request, null, 2)}</pre>
                                  </div>
                                )}

                                {item.entityId && (
                                  <div className="logs-detail-block">
                                    <span>Связанный объект</span>
                                    <code>{item.entityId}</code>
                                  </div>
                                )}
                              </div>
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {hasMore && (
              <div className="logs-more">
                <button className="outline-button" type="button" onClick={() => void loadMore()} disabled={loadingMore}>
                  {loadingMore ? "Загружаем…" : "Показать ещё"}
                </button>
                <span>Показано {formatNumber(items.length)} из {formatNumber(total)}</span>
              </div>
            )}
          </>
        )}
      </div>
    </section>
  );
}
