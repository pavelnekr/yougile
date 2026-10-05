import { useCallback, useEffect, useState } from "react";
import {
  Activity,
  AlertCircle,
  Ban,
  CheckCircle2,
  Clock3,
  FileSpreadsheet,
  KeyRound,
  LoaderCircle,
  RefreshCw,
  ShieldCheck,
  Trash2,
  UserPlus,
  UsersRound
} from "lucide-react";
import { apiFetch } from "./apiClient";
import Modal from "./Modal";
import type { PortalUser } from "./LoginPage";
import { activeForms, adminForms, blockedForms, countRu } from "./plural";

type Period = "30" | "90" | "all";

type AdminUserStats = {
  operations: number;
  succeeded: number;
  partial: number;
  failed: number;
  inProgress: number;
  sitesTotal: number;
  sitesSucceeded: number;
  sitesFailed: number;
  imports: number;
  byType: { ASSIGN: number; REMOVE: number; COMMENT: number };
  lastOperationAt: string | null;
};

type AdminUser = {
  id: string;
  login: string;
  displayName: string;
  role: string;
  active: boolean;
  yougileTokenConfigured: boolean;
  createdAt: string;
  activeSessions: number;
  lastSeenAt: string | null;
  stats: AdminUserStats;
};

type AdminTotals = {
  users: number;
  active: number;
  blocked: number;
  admins: number;
  operations: number;
  failedOperations: number;
  sitesSucceeded: number;
  sitesFailed: number;
  imports: number;
};

// Подписи ролей для выпадающих списков. Значения совпадают с enum PortalRole.
const roles = [
  { value: "ADMIN", label: "Администратор" },
  { value: "OPERATOR", label: "Оператор" },
  { value: "VIEWER", label: "Наблюдатель" }
] as const;

const operationTypeLabels: Record<string, string> = {
  ASSIGN: "назначений",
  REMOVE: "снятий",
  COMMENT: "комментариев"
};

const minPasswordLength = 8;

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Не удалось выполнить запрос.";
}

// Текст подтверждения изменения. Формулировки без родовых окончаний:
// в портале работают и мужчины, и женщины.
function describePatch(user: AdminUser, changes: { role?: string; active?: boolean }, revokedSessions: number) {
  if (changes.active === false) {
    return `${user.displayName}: доступ закрыт, сессий завершено — ${formatNumber(revokedSessions)}.`;
  }
  if (changes.active === true) {
    return `${user.displayName}: доступ восстановлен.`;
  }
  if (changes.role) {
    return `${user.displayName}: роль изменена на «${roles.find((item) => item.value === changes.role)?.label ?? changes.role}».`;
  }
  return `${user.displayName}: изменения сохранены.`;
}

function formatNumber(value: number) {
  return value.toLocaleString("ru-RU");
}

function formatDateTime(value: string | null) {
  if (!value) return "—";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "—";
  return date.toLocaleString("ru-RU", { dateStyle: "short", timeStyle: "short" });
}

// Пароль генерируется на клиенте: он никуда не уходит, пока администратор
// не подтвердит смену. Алфавит без похожих символов (0/O, 1/l).
function generatePassword() {
  const alphabet = "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const values = crypto.getRandomValues(new Uint32Array(14));
  return Array.from(values, (value) => alphabet[value % alphabet.length]).join("");
}

function PasswordDialog({
  user,
  onClose,
  onSubmit
}: {
  user: AdminUser;
  onClose: () => void;
  onSubmit: (password: string) => Promise<void>;
}) {
  const [password, setPassword] = useState(() => generatePassword());
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    if (saving) return;
    if (password.length < minPasswordLength) {
      setError(`Пароль должен быть не короче ${minPasswordLength} символов.`);
      return;
    }
    setSaving(true);
    setError("");
    try {
      await onSubmit(password);
    } catch (reason) {
      setError(errorMessage(reason));
      setSaving(false);
    }
  };

  return (
    <div className="modal-overlay" role="dialog" aria-modal="true" aria-labelledby="admin-password-title">
      <div className="modal-dialog">
        <div className="modal-heading">
          <span className="modal-icon"><KeyRound size={17} /></span>
          <div>
            <h2 id="admin-password-title">Новый пароль</h2>
            <p>{user.displayName} · {user.login}</p>
          </div>
        </div>
        <div className="modal-body">
          <label className="modal-field">
            <span>Пароль</span>
            <span className="modal-field-row">
              <input value={password} onChange={(event) => { setPassword(event.target.value); setError(""); }} autoFocus />
              <button type="button" className="text-button" onClick={() => setPassword(generatePassword())}>Сгенерировать</button>
            </span>
          </label>
          <p className="modal-note">
            Передайте пароль сотруднику любым защищённым каналом. Все активные сессии будут завершены,
            чтобы старый пароль не продолжал работать.
          </p>
          {error && <p className="modal-error" role="alert">{error}</p>}
        </div>
        <div className="modal-actions">
          <button type="button" className="text-button" onClick={onClose} disabled={saving}>Отмена</button>
          <button type="button" className="btn-primary" onClick={() => void submit()} disabled={saving}>
            {saving ? "Сохраняем…" : "Сменить пароль"}
          </button>
        </div>
      </div>
    </div>
  );
}

function YougileTokenDialog({
  user,
  configured,
  onClose,
  onSubmit,
  onRemove
}: {
  user: AdminUser;
  configured: boolean;
  onClose: () => void;
  onSubmit: (token: string) => Promise<void>;
  onRemove: () => Promise<void>;
}) {
  const [token, setToken] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    if (saving) return;
    if (!token.trim()) {
      setError("Введите токен YouGile.");
      return;
    }
    setSaving(true);
    setError("");
    try {
      await onSubmit(token.trim());
    } catch (reason) {
      setError(errorMessage(reason));
      setSaving(false);
    }
  };

  const remove = async () => {
    if (saving) return;
    setSaving(true);
    setError("");
    try {
      await onRemove();
    } catch (reason) {
      setError(errorMessage(reason));
      setSaving(false);
    }
  };

  return (
    <Modal labelledBy="admin-yougile-token-title" onDismiss={saving ? () => undefined : onClose}>
      <div className="modal-heading">
        <span className="modal-icon"><KeyRound size={17} /></span>
        <div>
          <h2 id="admin-yougile-token-title">Токен YouGile</h2>
          <p>{user.displayName} · {user.login}</p>
        </div>
      </div>
      <div className="modal-body">
        <label className="modal-field">
          <span>Персональный токен сотрудника</span>
          <input
            type="password"
            autoComplete="new-password"
            value={token}
            onChange={(event) => { setToken(event.target.value); setError(""); }}
            placeholder="Вставьте токен YouGile"
            autoFocus
          />
        </label>
        <p className="modal-note">
          {configured
            ? "Токен уже настроен, но его значение не отображается. Новый токен будет проверен и заменит текущий."
            : "Токен будет проверен в YouGile и сохранён в базе портала в зашифрованном виде."}
        </p>
        {error && <p className="modal-error" role="alert">{error}</p>}
      </div>
      <div className="modal-actions">
        {configured && (
          <button type="button" className="admin-action-button admin-action-danger" onClick={() => void remove()} disabled={saving}>
            <Trash2 size={13} /> Удалить
          </button>
        )}
        <button type="button" className="text-button" onClick={onClose} disabled={saving}>Отмена</button>
        <button type="button" className="btn-primary" onClick={() => void submit()} disabled={saving || !token.trim()}>
          {saving ? "Проверяем…" : "Сохранить"}
        </button>
      </div>
    </Modal>
  );
}

function CreateUserDialog({
  onClose,
  onSubmit
}: {
  onClose: () => void;
  onSubmit: (input: { login: string; displayName: string; password: string; role: string }) => Promise<void>;
}) {
  const [login, setLogin] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState(() => generatePassword());
  const [role, setRole] = useState("OPERATOR");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    if (saving) return;
    if (login.trim().length < 3) {
      setError("Логин должен быть не короче 3 символов.");
      return;
    }
    if (password.length < minPasswordLength) {
      setError(`Пароль должен быть не короче ${minPasswordLength} символов.`);
      return;
    }
    setSaving(true);
    setError("");
    try {
      await onSubmit({ login: login.trim(), displayName: displayName.trim(), password, role });
    } catch (reason) {
      setError(errorMessage(reason));
      setSaving(false);
    }
  };

  return (
    <div className="modal-overlay" role="dialog" aria-modal="true" aria-labelledby="admin-create-title">
      <div className="modal-dialog">
        <div className="modal-heading">
          <span className="modal-icon"><UserPlus size={17} /></span>
          <div>
            <h2 id="admin-create-title">Новая учётная запись</h2>
            <p>Сотрудник сможет войти сразу, ключ регистрации не нужен</p>
          </div>
        </div>
        <div className="modal-body">
          <label className="modal-field">
            <span>Логин</span>
            <input value={login} onChange={(event) => { setLogin(event.target.value); setError(""); }} placeholder="Например: ivanov" autoFocus />
          </label>
          <label className="modal-field">
            <span>Имя пользователя</span>
            <input value={displayName} onChange={(event) => setDisplayName(event.target.value)} placeholder="Иван Иванов" />
          </label>
          <label className="modal-field">
            <span>Роль</span>
            <select value={role} onChange={(event) => setRole(event.target.value)}>
              {roles.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
            </select>
          </label>
          <label className="modal-field">
            <span>Пароль</span>
            <span className="modal-field-row">
              <input value={password} onChange={(event) => { setPassword(event.target.value); setError(""); }} />
              <button type="button" className="text-button" onClick={() => setPassword(generatePassword())}>Сгенерировать</button>
            </span>
          </label>
          {error && <p className="modal-error" role="alert">{error}</p>}
        </div>
        <div className="modal-actions">
          <button type="button" className="text-button" onClick={onClose} disabled={saving}>Отмена</button>
          <button type="button" className="btn-primary" onClick={() => void submit()} disabled={saving}>
            {saving ? "Создаём…" : "Создать запись"}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function AdminUsersPage({
  currentUser,
  onCurrentUserTokenChanged
}: {
  currentUser: PortalUser;
  onCurrentUserTokenChanged: (configured: boolean) => void;
}) {
  const [period, setPeriod] = useState<Period>("30");
  const [items, setItems] = useState<AdminUser[]>([]);
  const [totals, setTotals] = useState<AdminTotals | null>(null);
  const [loading, setLoading] = useState(true);
  const [pendingId, setPendingId] = useState("");
  const [passwordTarget, setPasswordTarget] = useState<AdminUser | null>(null);
  const [yougileTokenTarget, setYougileTokenTarget] = useState<AdminUser | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const load = useCallback(async (days: Period, signal?: AbortSignal) => {
    const response = await apiFetch(`/api/admin/users?days=${days}`, signal ? { signal } : undefined);
    const data = await response.json() as { items?: AdminUser[]; totals?: AdminTotals; error?: string };
    if (!response.ok || !data.items || !data.totals) {
      throw new Error(data.error ?? "Не удалось загрузить учётные записи.");
    }
    setItems(data.items);
    setTotals(data.totals);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    load(period, controller.signal)
      .catch((reason) => {
        if (!controller.signal.aborted) setError(errorMessage(reason));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [load, period]);

  const refresh = async () => {
    try {
      await load(period);
    } catch (reason) {
      setError(errorMessage(reason));
    }
  };

  const patchUser = async (user: AdminUser, changes: { role?: string; active?: boolean }) => {
    if (pendingId) return;
    setPendingId(user.id);
    setError("");
    setNotice("");
    try {
      const response = await apiFetch(`/api/admin/users/${encodeURIComponent(user.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(changes)
      });
      const data = await response.json() as { error?: string; revokedSessions?: number };
      if (!response.ok) throw new Error(data.error ?? "Не удалось изменить учётную запись.");

      setNotice(describePatch(user, changes, data.revokedSessions ?? 0));
      await refresh();
    } catch (reason) {
      setError(errorMessage(reason));
      await refresh();
    } finally {
      setPendingId("");
    }
  };

  const submitPassword = async (user: AdminUser, password: string) => {
    const response = await apiFetch(`/api/admin/users/${encodeURIComponent(user.id)}/password`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password })
    });
    const data = await response.json() as { error?: string; revokedSessions?: number };
    if (!response.ok) throw new Error(data.error ?? "Не удалось сменить пароль.");

    setNotice(`Пароль ${user.displayName} изменён, завершено сессий: ${formatNumber(data.revokedSessions ?? 0)}.`);
    setPasswordTarget(null);
    await refresh();
  };

  const submitCreate = async (input: { login: string; displayName: string; password: string; role: string }) => {
    const response = await apiFetch("/api/admin/users", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...input, displayName: input.displayName || undefined })
    });
    const data = await response.json() as { error?: string; user?: { login: string } };
    if (!response.ok) throw new Error(data.error ?? "Не удалось создать учётную запись.");

    setNotice(`Учётная запись ${data.user?.login} создана.`);
    setCreateOpen(false);
    await refresh();
  };

  const submitYougileToken = async (user: AdminUser, token: string) => {
    const response = await apiFetch(`/api/admin/users/${encodeURIComponent(user.id)}/yougile-token`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token })
    });
    const data = await response.json() as { error?: string };
    if (!response.ok) throw new Error(data.error ?? "Не удалось сохранить токен YouGile.");

    setNotice(`Токен YouGile для ${user.displayName} проверен и сохранён.`);
    if (user.id === currentUser.id) onCurrentUserTokenChanged(true);
    setYougileTokenTarget(null);
    await refresh();
  };

  const removeYougileToken = async (user: AdminUser) => {
    const response = await apiFetch(`/api/admin/users/${encodeURIComponent(user.id)}/yougile-token`, {
      method: "DELETE"
    });
    const data = await response.json() as { error?: string };
    if (!response.ok) throw new Error(data.error ?? "Не удалось удалить токен YouGile.");

    setNotice(`Токен YouGile для ${user.displayName} удалён.`);
    if (user.id === currentUser.id) onCurrentUserTokenChanged(false);
    setYougileTokenTarget(null);
    await refresh();
  };

  const periodLabel = period === "all" ? "за всё время" : `за ${period} дней`;

  return (
    <section className="section-view admin-page">
      <div className="eyebrow"><span className="eyebrow-line" /> АДМИНИСТРИРОВАНИЕ ПОРТАЛА</div>

      <div className="section-hero admin-hero">
        <span className="section-hero-icon"><UsersRound size={22} /></span>
        <div>
          <h1>Учётные записи</h1>
          <p>Кто работает в портале, с какими правами, и что сотрудники запускали {periodLabel}.</p>
        </div>
        <div className="admin-hero-actions">
          <div className="history-period" role="group" aria-label="Период статистики">
            {(["30", "90", "all"] as Period[]).map((value) => (
              <button
                key={value}
                className={period === value ? "history-period-active" : ""}
                onClick={() => setPeriod(value)}
              >
                {value === "all" ? "Всё время" : `${value} дней`}
              </button>
            ))}
          </div>
          <button className="btn-primary" onClick={() => setCreateOpen(true)}><UserPlus size={15} /> Создать запись</button>
          <button className="icon-button" aria-label="Обновить" onClick={() => void refresh()} disabled={loading}>
            <RefreshCw size={16} />
          </button>
        </div>
      </div>

      {totals && (
        <div className="history-stat-grid admin-stat-grid">
          <div className="panel history-stat-card">
            <span className="history-stat-icon"><UsersRound size={16} /></span>
            <span className="history-stat-label">Учётных записей</span>
            <strong>{formatNumber(totals.users)}</strong>
            <small>
              {countRu(totals.active, activeForms)} · {countRu(totals.blocked, blockedForms)} · {countRu(totals.admins, adminForms)}
            </small>
          </div>
          <div className="panel history-stat-card history-stat-blue">
            <span className="history-stat-icon"><Activity size={16} /></span>
            <span className="history-stat-label">Операций {periodLabel}</span>
            <strong>{formatNumber(totals.operations)}</strong>
            <small>ошибок: {formatNumber(totals.failedOperations)}</small>
          </div>
          <div className="panel history-stat-card history-stat-green">
            <span className="history-stat-icon"><CheckCircle2 size={16} /></span>
            <span className="history-stat-label">Площадок обработано</span>
            <strong>{formatNumber(totals.sitesSucceeded)}</strong>
            <small>с ошибкой: {formatNumber(totals.sitesFailed)}</small>
          </div>
          <div className="panel history-stat-card history-stat-violet">
            <span className="history-stat-icon"><FileSpreadsheet size={16} /></span>
            <span className="history-stat-label">Загрузок XLSX {periodLabel}</span>
            <strong>{formatNumber(totals.imports)}</strong>
            <small>файлов в плане работ</small>
          </div>
        </div>
      )}

      {error && <div className="admin-feedback admin-feedback-error" role="alert"><AlertCircle size={15} />{error}</div>}
      {notice && <div className="admin-feedback admin-feedback-success" role="status"><CheckCircle2 size={15} />{notice}</div>}

      <div className="panel admin-users-panel">
        <div className="panel-heading">
          <div><h2>Сотрудники</h2><p>Блокировка завершает сессии, смена пароля — тоже. Свою роль и доступ снять нельзя.</p></div>
        </div>

        {loading && !items.length ? (
          <div className="admin-loading"><LoaderCircle size={16} className="template-spinner" /> Загружаем учётные записи…</div>
        ) : (
          <div className="history-table-wrap admin-table-wrap">
            <table className="history-users-table admin-users-table">
              <thead>
                <tr>
                  <th>Сотрудник</th>
                  <th>Роль</th>
                  <th>Доступ</th>
                  <th>Активность</th>
                  <th>Операции {periodLabel}</th>
                  <th>Площадки</th>
                  <th>XLSX</th>
                  <th>Действия</th>
                </tr>
              </thead>
              <tbody>
                {items.map((user) => {
                  const isSelf = user.id === currentUser.id;
                  const busy = pendingId === user.id;
                  return (
                    <tr key={user.id} className={user.active ? "" : "admin-row-blocked"}>
                      <td>
                        <span className="history-user-name">
                          <span>{user.displayName.slice(0, 1).toLocaleUpperCase("ru")}</span>
                          <span className="admin-user-copy">
                            <strong>{user.displayName}</strong>
                            <small>{user.login}{isSelf ? " · это вы" : ""}</small>
                          </span>
                        </span>
                      </td>
                      <td>
                        <select
                          className="admin-role-select"
                          value={user.role}
                          disabled={isSelf || busy}
                          title={isSelf ? "Свою роль сменить нельзя" : "Сменить роль"}
                          onChange={(event) => void patchUser(user, { role: event.target.value })}
                        >
                          {roles.map((role) => <option key={role.value} value={role.value}>{role.label}</option>)}
                        </select>
                      </td>
                      <td>
                        <span className={`admin-badge ${user.active ? "admin-badge-active" : "admin-badge-blocked"}`}>
                          {user.active ? <ShieldCheck size={12} /> : <Ban size={12} />}
                          {user.active ? "Активен" : "Заблокирован"}
                        </span>
                        <small className="admin-cell-note">сессий: {formatNumber(user.activeSessions)}</small>
                      </td>
                      <td>
                        <span className="admin-cell-note">вход: {formatDateTime(user.lastSeenAt)}</span>
                        <span className="admin-cell-note">операция: {formatDateTime(user.stats.lastOperationAt)}</span>
                      </td>
                      <td>
                        <strong>{formatNumber(user.stats.operations)}</strong>
                        <span className="admin-cell-note">
                          успешно {formatNumber(user.stats.succeeded + user.stats.partial)} · ошибок {formatNumber(user.stats.failed)}
                        </span>
                        <span className="admin-cell-note">
                          {user.stats.byType.ASSIGN} {operationTypeLabels.ASSIGN} · {user.stats.byType.REMOVE} {operationTypeLabels.REMOVE} · {user.stats.byType.COMMENT} {operationTypeLabels.COMMENT}
                        </span>
                      </td>
                      <td>
                        <strong>{formatNumber(user.stats.sitesSucceeded)}</strong>
                        <span className="admin-cell-note">из {formatNumber(user.stats.sitesTotal)} · ошибок {formatNumber(user.stats.sitesFailed)}</span>
                      </td>
                      <td>{formatNumber(user.stats.imports)}</td>
                      <td>
                        <div className="admin-row-actions">
                          <button
                            className="admin-action-button"
                            disabled={busy}
                            onClick={() => setPasswordTarget(user)}
                            title="Сменить пароль"
                          >
                            <KeyRound size={13} /> Пароль
                          </button>
                          <button
                            className="admin-action-button"
                            disabled={busy}
                            onClick={() => setYougileTokenTarget(user)}
                            title={user.yougileTokenConfigured ? "Заменить токен YouGile" : "Добавить токен YouGile"}
                          >
                            <KeyRound size={13} /> {user.yougileTokenConfigured ? "YouGile" : "Подключить"}
                          </button>
                          <small className="admin-cell-note">
                            {user.yougileTokenConfigured ? "Токен настроен" : "Токена нет"}
                          </small>
                          <button
                            className={`admin-action-button ${user.active ? "admin-action-danger" : ""}`}
                            disabled={isSelf || busy}
                            title={isSelf ? "Себя заблокировать нельзя" : user.active ? "Заблокировать" : "Разблокировать"}
                            onClick={() => void patchUser(user, { active: !user.active })}
                          >
                            <Ban size={13} /> {user.active ? "Блокировать" : "Разблокировать"}
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {!items.length && <div className="admin-loading">Учётных записей нет.</div>}
          </div>
        )}

        <p className="admin-panel-note">
          <Clock3 size={13} /> Статистика собирается по операциям, у которых записан автор. Операции, запущенные до появления
          автора в базе, остаются без владельца и здесь не видны.
        </p>
      </div>

      {passwordTarget && (
        <PasswordDialog user={passwordTarget} onClose={() => setPasswordTarget(null)} onSubmit={(password) => submitPassword(passwordTarget, password)} />
      )}
      {yougileTokenTarget && (
        <YougileTokenDialog
          user={yougileTokenTarget}
          configured={yougileTokenTarget.yougileTokenConfigured}
          onClose={() => setYougileTokenTarget(null)}
          onSubmit={(token) => submitYougileToken(yougileTokenTarget, token)}
          onRemove={() => removeYougileToken(yougileTokenTarget)}
        />
      )}
      {createOpen && (
        <CreateUserDialog onClose={() => setCreateOpen(false)} onSubmit={submitCreate} />
      )}

      <footer className="page-footer"><span>YouGile Operations Portal <span className="footer-version">v0.1</span></span><span>Раздел доступен администраторам</span></footer>
    </section>
  );
}
