import { useEffect, useState } from "react";
import {
  Activity,
  AlertCircle,
  ArrowDownToLine,
  ArrowUpRight,
  Clock3,
  FileSpreadsheet,
  MessageSquarePlus,
  Search,
  UsersRound
} from "lucide-react";

type Period = "30" | "90" | "all";
type HistoryType = "ALL" | "ASSIGN" | "REMOVE" | "COMMENT";
type HistorySummary = {
  period: Period;
  totals: {
    uploads: number;
    operations: number;
    assignmentOperations: number;
    assignments: number;
    removals: number;
    commentOperations: number;
    comments: number;
    successfulItems: number;
    failedItems: number;
    pendingOperations: number;
  };
  activity: { key: string; label: string; uploads: number; assignments: number; removals: number; comments: number }[];
  users: { name: string; uploads: number; operations: number; assignments: number; removals: number; comments: number }[];
  engineers: { name: string; assignments: number; removals: number }[];
  engineerNamesAvailable: boolean;
  recentUploads: { fileName: string; rowCount: number; status: string; createdAt: string; uploadedBy: string }[];
  uploadRetentionNote: string;
};
type HistoryItem = {
  id: string;
  operationId: string;
  type: "ASSIGN" | "REMOVE" | "COMMENT";
  status: "PENDING" | "SUCCEEDED" | "FAILED" | "SKIPPED";
  operationStatus: string;
  siteId: string;
  engineer: string;
  address: string | null;
  rowNumber: number | null;
  fileName: string | null;
  comment: string | null;
  user: string;
  error: string | null;
  createdAt: string;
};
type HistoryItems = { page: number; pageSize: number; total: number; items: HistoryItem[] };

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Не удалось загрузить историю операций.";
}

function formatDate(value: string) {
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? date.toLocaleString("ru-RU", { dateStyle: "medium", timeStyle: "short" })
    : "Дата неизвестна";
}

function number(value: number) {
  return value.toLocaleString("ru-RU");
}

function itemStatusLabel(status: HistoryItem["status"]) {
  if (status === "SUCCEEDED") return "Выполнено";
  if (status === "FAILED") return "Ошибка";
  if (status === "SKIPPED") return "Без изменений";
  return "В очереди";
}

const actionLabels: Record<HistoryItem["type"], string> = {
  ASSIGN: "Назначение",
  REMOVE: "Снятие",
  COMMENT: "Комментарий"
};

export default function HistoryPage() {
  const [period, setPeriod] = useState<Period>("30");
  const [summary, setSummary] = useState<HistorySummary | null>(null);
  const [records, setRecords] = useState<HistoryItems | null>(null);
  const [page, setPage] = useState(1);
  const [type, setType] = useState<HistoryType>("ALL");
  const [search, setSearch] = useState("");
  const [loadingSummary, setLoadingSummary] = useState(true);
  const [loadingRecords, setLoadingRecords] = useState(true);
  const [error, setError] = useState("");
  const [recordsError, setRecordsError] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    setLoadingSummary(true);
    setError("");
    fetch(`/api/history/summary?days=${period}`, { signal: controller.signal })
      .then(async (response) => {
        const data = await response.json() as HistorySummary & { error?: string };
        if (!response.ok) throw new Error(data.error ?? "Не удалось загрузить статистику.");
        return data;
      })
      .then(setSummary)
      .catch((reason: unknown) => {
        if (!controller.signal.aborted) setError(errorMessage(reason));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoadingSummary(false);
      });
    return () => controller.abort();
  }, [period]);

  useEffect(() => {
    const controller = new AbortController();
    const params = new URLSearchParams({
      days: period,
      page: String(page),
      type,
      search
    });
    setLoadingRecords(true);
    setRecordsError("");
    fetch(`/api/history/items?${params.toString()}`, { signal: controller.signal })
      .then(async (response) => {
        const data = await response.json() as HistoryItems & { error?: string };
        if (!response.ok) throw new Error(data.error ?? "Не удалось загрузить список работ.");
        return data;
      })
      .then(setRecords)
      .catch((reason: unknown) => {
        if (!controller.signal.aborted) setRecordsError(errorMessage(reason));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoadingRecords(false);
      });
    return () => controller.abort();
  }, [period, page, type, search]);

  const total = summary?.totals;
  const maxActivity = Math.max(1, ...(summary?.activity.flatMap((day) => [day.uploads, day.assignments, day.removals, day.comments]) ?? []));
  const maxEngineerActivity = Math.max(1, ...(summary?.engineers.map((person) => person.assignments) ?? []));
  const pageCount = Math.max(1, Math.ceil((records?.total ?? 0) / (records?.pageSize ?? 25)));

  return (
    <section className="section-view history-page">
      <div className="eyebrow"><span className="eyebrow-line" /> АНАЛИТИКА И ЖУРНАЛ</div>
      <div className="history-heading">
        <div><h1>История операций</h1><p>Загрузки XLSX, назначения инженеров, снятия и комментарии — в одном отчёте.</p></div>
        <div className="history-period" role="group" aria-label="Период статистики">
          {([["30", "30 дней"], ["90", "90 дней"], ["all", "Всё время"]] as const).map(([value, label]) => (
            <button key={value} className={period === value ? "history-period-active" : ""} onClick={() => { setPeriod(value); setPage(1); }}>{label}</button>
          ))}
        </div>
      </div>

      {error && <div className="assignment-error"><AlertCircle size={15} />{error}</div>}

      <div className="history-stat-grid">
        <HistoryStat icon={ArrowUpRight} label="Работ назначено" value={total?.assignments} foot={`${number(total?.assignmentOperations ?? 0)} операций назначения`} tone="green" loading={loadingSummary} />
        <HistoryStat icon={ArrowDownToLine} label="Работ снято" value={total?.removals} foot="Инженеры сняты с площадок" tone="violet" loading={loadingSummary} />
        <HistoryStat icon={MessageSquarePlus} label="Комментариев отправлено" value={total?.comments} foot={`${number(total?.commentOperations ?? 0)} операций комментариев`} tone="blue" loading={loadingSummary} />
        <HistoryStat icon={Activity} label="С ошибкой" value={total?.failedItems} foot={`${number(total?.successfulItems ?? 0)} успешно · ${number(total?.pendingOperations ?? 0)} выполняется`} tone="amber" loading={loadingSummary} />
      </div>

      <div className="history-charts-grid">
        <section className="panel history-panel history-activity-panel">
          <div className="history-panel-heading"><div><h2>Активность по периодам</h2><p>Загрузки и количество строк назначения / снятия / комментариев</p></div><span className="history-panel-icon"><Activity size={15} /></span></div>
          {loadingSummary ? <div className="import-audit-message">Собираем статистику…</div> : summary?.activity.length ? (
            <>
              <div className="history-chart-legend"><span><i className="legend-upload" /> XLSX</span><span><i className="legend-assign" /> Назначено</span><span><i className="legend-remove" /> Снято</span><span><i className="legend-comment" /> Комментарии</span></div>
              <div className={`history-bar-chart ${summary.activity.length > 18 ? "history-bar-chart-dense" : ""}`}>
                {summary.activity.map((day) => {
                  const maxBarHeight = 122;
                  return (
                    <div className="history-chart-column" key={day.key} title={`${day.label}: XLSX ${day.uploads}, назначено ${day.assignments}, снято ${day.removals}, комментариев ${day.comments}`}>
                      <div className="history-bar-stack">
                        <i className="history-bar-upload" style={{ height: `${Math.max(day.uploads > 0 ? 3 : 0, day.uploads / maxActivity * maxBarHeight)}px` }} />
                        <i className="history-bar-assign" style={{ height: `${Math.max(day.assignments > 0 ? 3 : 0, day.assignments / maxActivity * maxBarHeight)}px` }} />
                        <i className="history-bar-remove" style={{ height: `${Math.max(day.removals > 0 ? 3 : 0, day.removals / maxActivity * maxBarHeight)}px` }} />
                        <i className="history-bar-comment" style={{ height: `${Math.max(day.comments > 0 ? 3 : 0, day.comments / maxActivity * maxBarHeight)}px` }} />
                      </div>
                      <span>{day.label}</span>
                    </div>
                  );
                })}
              </div>
            </>
          ) : <div className="history-empty">За этот период операций нет.</div>}
        </section>

        <section className="panel history-panel history-engineers-panel">
          <div className="history-panel-heading"><div><h2>Работы по инженерам</h2><p>Сколько назначено и снято по планам</p></div><span className="history-panel-icon"><UsersRound size={15} /></span></div>
          {summary && !summary.engineerNamesAvailable && <div className="history-retention-note"><AlertCircle size={13} />Не удалось получить имена инженеров из YouGile; для старых операций вместо имени может отображаться идентификатор.</div>}
          {loadingSummary ? <div className="import-audit-message">Собираем статистику…</div> : summary?.engineers.length ? (
            <div className="history-engineer-list">
              {summary.engineers.map((engineer) => (
                <div className="history-engineer-row" key={engineer.name}>
                  <span className="history-engineer-name" title={engineer.name}>{engineer.name}</span>
                  <div className="history-engineer-bars">
                    <span className="engineer-assigned-bar" style={{ width: `${Math.max(engineer.assignments ? 3 : 0, engineer.assignments / maxEngineerActivity * 100)}%` }} />
                    <span className="engineer-removed-bar" style={{ width: `${Math.max(engineer.removals ? 3 : 0, engineer.removals / maxEngineerActivity * 100)}%` }} />
                  </div>
                  <span className="history-engineer-count">{number(engineer.assignments)} / {number(engineer.removals)}</span>
                </div>
              ))}
              <div className="history-engineer-legend"><span><i className="legend-assign" /> Назначено</span><span><i className="legend-remove" /> Снято</span></div>
            </div>
          ) : <div className="history-empty">Пока нет данных о назначенных инженерах.</div>}
        </section>
      </div>

      <section className="panel history-panel history-users-panel">
        <div className="history-panel-heading"><div><h2>Активность пользователей</h2><p>Загрузки XLSX и выполненные через портал операции</p></div><span className="history-panel-icon"><UsersRound size={15} /></span></div>
        {summary?.uploadRetentionNote && <div className="history-retention-note"><AlertCircle size={13} />{summary.uploadRetentionNote}</div>}
        {loadingSummary ? <div className="import-audit-message">Собираем статистику…</div> : summary?.users.length ? (
          <div className="history-table-wrap">
            <table className="history-users-table">
              <thead><tr><th>Пользователь</th><th>Загрузил XLSX</th><th>Операций</th><th>Назначено</th><th>Снято</th><th>Комментариев</th></tr></thead>
              <tbody>{summary.users.map((user) => (
                <tr key={user.name}><td><span className="history-user-name"><span>{user.name.slice(0, 1).toLocaleUpperCase("ru")}</span>{user.name}</span></td><td>{number(user.uploads)}</td><td>{number(user.operations)}</td><td>{number(user.assignments)}</td><td>{number(user.removals)}</td><td>{number(user.comments)}</td></tr>
              ))}</tbody>
            </table>
          </div>
        ) : <div className="history-empty">За этот период пользователей и загрузок нет.</div>}
        <p className="history-auth-note">До подключения авторизации загрузки и операции отображаются под именем «Локальный оператор».</p>
      </section>

      <section className="panel history-panel history-records-panel">
        <div className="history-panel-heading">
          <div><h2>Какие работы выполнялись</h2><p>{records ? `${number(records.total)} записей за выбранный период` : "Назначения, снятия и комментарии по каждой площадке"}</p></div>
          <span className="history-panel-icon"><Clock3 size={15} /></span>
        </div>
        <div className="history-record-filters">
          <label className="history-search"><Search size={14} /><input value={search} onChange={(event) => { setSearch(event.target.value); setPage(1); }} placeholder="Площадка, адрес или инженер" /></label>
          <select value={type} onChange={(event) => { setType(event.target.value as HistoryType); setPage(1); }} aria-label="Тип операции">
            <option value="ALL">Все операции</option><option value="ASSIGN">Назначения</option><option value="REMOVE">Снятия</option><option value="COMMENT">Комментарии</option>
          </select>
        </div>
        {recordsError && <div className="import-audit-message import-audit-message-error"><AlertCircle size={15} />{recordsError}</div>}
        {loadingRecords ? <div className="import-audit-message">Загружаем работы…</div> : records && records.items.length ? (
          <>
            <div className="history-table-wrap">
              <table className="history-records-table">
                <thead><tr><th>Дата</th><th>Действие</th><th>Площадка и работа</th><th>{type === "COMMENT" ? "Комментарий" : "Инженер"}</th><th>Пользователь</th><th>Файл XLSX</th><th>Статус</th></tr></thead>
                <tbody>{records.items.map((item) => (
                  <tr key={item.id}>
                    <td>{formatDate(item.createdAt)}</td>
                    <td><span className={`history-action history-action-${item.type.toLowerCase()}`}>{actionLabels[item.type]}</span></td>
                    <td><strong className="history-site-id">{item.siteId}</strong>{item.address && <small className="history-site-address" title={item.address}>{item.address}</small>}</td>
                    <td>{type === "COMMENT" && item.comment
                      ? <span className="history-comment-cell" title={item.comment}>{item.comment}</span>
                      : item.engineer}</td>
                    <td>{item.user}</td>
                    <td title={item.fileName ?? ""}>{item.fileName ?? "—"}</td>
                    <td><span className={`history-item-status history-item-status-${item.status.toLowerCase()}`} title={item.error ?? ""}>{itemStatusLabel(item.status)}</span></td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
            <div className="history-pagination">
              <span>Показано {number((page - 1) * (records?.pageSize ?? 25) + 1)}–{number(Math.min(page * (records?.pageSize ?? 25), records.total))} из {number(records.total)}</span>
              <div><button disabled={page <= 1} onClick={() => setPage((value) => Math.max(1, value - 1))}>Назад</button><span>{page} / {pageCount}</span><button disabled={page >= pageCount} onClick={() => setPage((value) => value + 1)}>Дальше</button></div>
            </div>
          </>
        ) : !recordsError ? <div className="history-empty">Работ по выбранным фильтрам не найдено.</div> : null}
      </section>

      <section className="panel history-panel history-uploads-panel">
        <div className="history-panel-heading"><div><h2>Последние XLSX</h2><p>Файлы, загруженные в выбранный период</p></div><span className="history-panel-icon"><FileSpreadsheet size={15} /></span></div>
        {summary?.recentUploads.length ? (
          <div className="history-upload-list">{summary.recentUploads.map((upload) => (
            <div className="history-upload-row" key={`${upload.fileName}-${upload.createdAt}`}>
              <span className="xlsx-file-icon"><FileSpreadsheet size={15} /></span>
              <span className="history-upload-file"><strong title={upload.fileName}>{upload.fileName}</strong><small>{number(upload.rowCount)} строк · {formatDate(upload.createdAt)} · {upload.uploadedBy}</small></span>
              <span className={`import-audit-status import-audit-status-${upload.status.toLowerCase()}`}>{upload.status === "COMPLETE" ? "Завершена" : upload.status === "ASSIGNING" ? "В обработке" : "Загружена"}</span>
            </div>
          ))}</div>
        ) : <div className="history-empty">Загруженных XLSX за этот период нет.</div>}
      </section>

      <footer className="page-footer"><span>YouGile Operations Portal <span className="footer-version">v0.1</span></span><span>Статистика и детализация по сохранённым операциям</span></footer>
    </section>
  );
}

function HistoryStat({
  icon: Icon,
  label,
  value,
  foot,
  tone,
  loading
}: {
  icon: typeof Activity;
  label: string;
  value: number | undefined;
  foot: string;
  tone: string;
  loading: boolean;
}) {
  return (
    <div className={`panel history-stat-card history-stat-${tone}`}>
      <span className="history-stat-icon"><Icon size={16} /></span>
      <span className="history-stat-label">{label}</span>
      <strong>{loading ? "—" : number(value ?? 0)}</strong>
      <small>{foot}</small>
    </div>
  );
}
