import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { AlertCircle, CalendarDays, Check, ChevronLeft, ChevronRight, ClipboardList, LoaderCircle, Pencil, Plus, RotateCcw, Search, Trash2, X } from "lucide-react";
import { apiFetch } from "./apiClient.js";
import { PORTAL_VERSION } from "./version.js";

const fields = [
  { key: "free1", label: "Свободное поле 1", type: "text" },
  { key: "data", label: "Дата", type: "date" },
  { key: "day", label: "День", type: "text" },
  { key: "time", label: "Время / интервал", type: "text" },
  { key: "id_site", label: "ID площадки", type: "text", required: true },
  { key: "address", label: "Адрес", type: "text" },
  { key: "PO", label: "ПО", type: "text" },
  { key: "comment", label: "Комментарий", type: "textarea" },
  { key: "free2", label: "Свободное поле 2", type: "text" },
  { key: "free3", label: "Свободное поле 3", type: "text" },
  { key: "user", label: "Ответственный", type: "text" },
  { key: "comment2", label: "Комментарий 2", type: "textarea" },
  { key: "status", label: "Статус", type: "text" },
  { key: "klaster", label: "Кластер", type: "text" }
] as const;

type FieldKey = typeof fields[number]["key"];
type WorkForm = Record<FieldKey, string>;
type PlanningWork = WorkForm & { id: string; createdAt: string; updatedAt: string };
type PageData = { items: PlanningWork[]; total: number; page: number; pageSize: number; statuses: string[]; days: string[]; clusters: string[]; users: string[]; error?: string };
type Filters = { q: string; siteId: string; status: string; day: string; klaster: string; user: string; from: string; to: string };
const emptyForm = (): WorkForm => Object.fromEntries(fields.map(({ key }) => [key, ""])) as WorkForm;
const blankFilters: Filters = { q: "", siteId: "", status: "", day: "", klaster: "", user: "", from: "", to: "" };
const pageSize = 50;

function formatDate(value: string) {
  if (!value) return "—";
  const [year, month, day] = value.split("-");
  return `${day}.${month}.${year}`;
}

export default function PlanningWorkPage({ canEdit }: { canEdit: boolean }) {
  const [items, setItems] = useState<PlanningWork[]>([]);
  const [statuses, setStatuses] = useState<string[]>([]);
  const [days, setDays] = useState<string[]>([]);
  const [clusters, setClusters] = useState<string[]>([]);
  const [users, setUsers] = useState<string[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [filters, setFilters] = useState<Filters>(blankFilters);
  const [filterDraft, setFilterDraft] = useState<Filters>(blankFilters);
  const [form, setForm] = useState<WorkForm>(emptyForm);
  const [editingId, setEditingId] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [deletingId, setDeletingId] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const query = useMemo(() => {
    const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
    for (const [key, value] of Object.entries(filters)) if (value) params.set(key, value);
    return params.toString();
  }, [filters, page]);

  const loadWorks = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setError("");
    try {
      const response = await apiFetch(`/api/planning/works?${query}`, { cache: "no-store", signal });
      const result = await response.json() as PageData;
      if (!response.ok) throw new Error(result.error ?? "Не удалось загрузить список работ.");
      setItems(result.items);
      setTotal(result.total);
      setStatuses(result.statuses);
      setDays(result.days);
      setClusters(result.clusters);
      setUsers(result.users);
    } catch (reason) {
      if (signal?.aborted) return;
      setError(reason instanceof Error ? reason.message : "Не удалось загрузить список работ.");
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [query]);

  useEffect(() => {
    const controller = new AbortController();
    void loadWorks(controller.signal);
    return () => controller.abort();
  }, [loadWorks]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setPage(1);
      setFilters({ ...filterDraft });
    }, 250);
    return () => window.clearTimeout(timer);
  }, [filterDraft]);

  const updateField = (key: FieldKey, value: string) => setForm((current) => ({ ...current, [key]: value }));

  const resetForm = () => {
    setForm(emptyForm());
    setEditingId("");
  };

  const submitWork = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const response = await apiFetch(editingId ? `/api/planning/works/${encodeURIComponent(editingId)}` : "/api/planning/works", {
        method: editingId ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form)
      });
      const result = await response.json() as { error?: string };
      if (!response.ok) throw new Error(result.error ?? "Не удалось сохранить работу.");
      setNotice(editingId ? "Изменения сохранены." : "Работа добавлена в план.");
      resetForm();
      if (page !== 1) setPage(1);
      else await loadWorks();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Не удалось сохранить работу.");
    } finally {
      setSaving(false);
    }
  };

  const beginEdit = (work: PlanningWork) => {
    const next = emptyForm();
    for (const { key } of fields) next[key] = work[key] ?? "";
    setForm(next);
    setEditingId(work.id);
    setNotice("");
    document.querySelector(".planning-entry-panel")?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  const deleteWork = async (work: PlanningWork) => {
    if (!window.confirm(`Удалить работу по площадке «${work.id_site}»?`)) return;
    setDeletingId(work.id);
    setError("");
    setNotice("");
    try {
      const response = await apiFetch(`/api/planning/works/${encodeURIComponent(work.id)}`, { method: "DELETE" });
      if (!response.ok) {
        const result = await response.json() as { error?: string };
        throw new Error(result.error ?? "Не удалось удалить работу.");
      }
      setNotice("Работа удалена.");
      if (items.length === 1 && page > 1) setPage((value) => value - 1);
      else await loadWorks();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Не удалось удалить работу.");
    } finally {
      setDeletingId("");
    }
  };

  const submitFilters = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setPage(1);
    setFilters({ ...filterDraft });
  };

  const clearFilters = () => {
    setFilterDraft(blankFilters);
    setFilters(blankFilters);
    setPage(1);
  };

  const pageCount = Math.max(1, Math.ceil(total / pageSize));

  return (
    <section className="section-view planning-page">
      <div className="eyebrow"><span className="eyebrow-line" /> РАБОЧЕЕ ПРОСТРАНСТВО</div>
      <div className="section-hero planning-hero">
        <span className="section-hero-icon"><CalendarDays size={22} /></span>
        <div><h1>Планирование работ</h1><p>Добавляйте работы в общий план и находите нужные по площадке, дате, статусу или ответственному.</p></div>
      </div>

      {canEdit ? <form className="panel planning-entry-panel" onSubmit={submitWork}>
        <div className="planning-panel-heading">
          <div><span className="planning-step-icon"><Plus size={16} /></span><div><h2>{editingId ? "Изменить работу" : "Новая работа"}</h2><p>{editingId ? "Измените поля и сохраните запись." : "Укажите площадку и заполните сведения о работе."}</p></div></div>
          {editingId && <button type="button" className="text-button" onClick={resetForm}><X size={14} /> Отменить редактирование</button>}
        </div>

        <div className="planning-fields planning-fields-primary">
          {fields.filter(({ key }) => ["data", "day", "time", "id_site", "address", "PO", "user", "status", "klaster"].includes(key)).map((field) => (
            <label className={`planning-field planning-field-${field.key}`} key={field.key}>
              <span>{field.label}{"required" in field && field.required ? " *" : ""}</span>
              <input required={"required" in field && field.required} type={field.type} placeholder={field.key === "day" ? "например, ночь" : field.key === "time" ? "например, 00:00–06:00" : undefined} value={form[field.key]} onChange={(event) => updateField(field.key, event.target.value)} maxLength={field.key === "id_site" ? 100 : undefined} />
            </label>
          ))}
        </div>
        <div className="planning-fields planning-fields-notes">
          {fields.filter(({ key }) => ["comment", "comment2"].includes(key)).map((field) => (
            <label className="planning-field" key={field.key}><span>{field.label}</span><textarea rows={2} value={form[field.key]} onChange={(event) => updateField(field.key, event.target.value)} /></label>
          ))}
        </div>
        <details className="planning-extra-fields">
          <summary>Дополнительные поля XLSX</summary>
          <div className="planning-fields planning-fields-extra">
            {fields.filter(({ key }) => ["free1", "free2", "free3"].includes(key)).map((field) => (
              <label className="planning-field" key={field.key}><span>{field.label} <code>{field.key}</code></span><input value={form[field.key]} onChange={(event) => updateField(field.key, event.target.value)} /></label>
            ))}
          </div>
        </details>
        <div className="planning-form-footer">
          <p>* Обязательное поле</p>
          <button className="btn-primary" type="submit" disabled={!canEdit || saving}><span>{saving ? <LoaderCircle size={15} className="template-spinner" /> : editingId ? <Check size={15} /> : <Plus size={15} />}</span>{saving ? "Сохраняем…" : editingId ? "Сохранить изменения" : "Добавить работу"}</button>
        </div>
      </form> : <div className="panel planning-readonly-note"><ClipboardList size={16} /><span>Режим просмотра: вы можете фильтровать и изучать план, но добавлять или изменять работы нельзя.</span></div>}

      {notice && <div className="planning-feedback planning-feedback-success"><Check size={15} /> {notice}</div>}
      {error && <div className="planning-feedback planning-feedback-error"><AlertCircle size={15} /> {error}</div>}

      <div className="planning-list-heading">
        <div><span className="planning-list-icon"><ClipboardList size={17} /></span><div><h2>Все работы</h2><p>{loading ? "Обновляем список…" : `${total.toLocaleString("ru-RU")} ${total === 1 ? "запись" : "записей"}`}</p></div></div>
      </div>

      <form className="panel planning-filters" onSubmit={submitFilters}>
        <label className="planning-search"><Search size={16} /><input aria-label="Поиск по таблице" placeholder="Площадка, адрес, ПО, ответственный…" value={filterDraft.q} onChange={(event) => setFilterDraft((current) => ({ ...current, q: event.target.value }))} /></label>
        <label><span>ID площадки</span><input inputMode="search" placeholder="Например, 6502" value={filterDraft.siteId} onChange={(event) => setFilterDraft((current) => ({ ...current, siteId: event.target.value }))} /></label>
        <label><span>Статус</span><select value={filterDraft.status} onChange={(event) => setFilterDraft((current) => ({ ...current, status: event.target.value }))}><option value="">Все статусы</option>{statuses.map((status) => <option value={status} key={status}>{status}</option>)}</select></label>
        <label><span>Смена / день</span><select value={filterDraft.day} onChange={(event) => setFilterDraft((current) => ({ ...current, day: event.target.value }))}><option value="">Все смены</option>{days.map((day) => <option value={day} key={day}>{day}</option>)}</select></label>
        <label><span>Кластер</span><select value={filterDraft.klaster} onChange={(event) => setFilterDraft((current) => ({ ...current, klaster: event.target.value }))}><option value="">Все кластеры</option>{clusters.map((cluster) => <option value={cluster} key={cluster}>{cluster}</option>)}</select></label>
        <label><span>Ответственный</span><select value={filterDraft.user} onChange={(event) => setFilterDraft((current) => ({ ...current, user: event.target.value }))}><option value="">Все ответственные</option>{users.map((user) => <option value={user} key={user}>{user}</option>)}</select></label>
        <label><span>Дата с</span><input type="date" value={filterDraft.from} onChange={(event) => setFilterDraft((current) => ({ ...current, from: event.target.value }))} /></label>
        <label><span>Дата по</span><input type="date" value={filterDraft.to} onChange={(event) => setFilterDraft((current) => ({ ...current, to: event.target.value }))} /></label>
        <button className="planning-filter-reset" type="button" onClick={clearFilters} title="Сбросить фильтры"><RotateCcw size={14} /> Сбросить</button>
      </form>

      <div className="panel planning-table-panel">
        <div className="planning-table-scroll">
          <table className="planning-table">
            <thead><tr>{fields.map((field) => <th key={field.key}>{field.label}</th>)}{canEdit && <th className="planning-actions-heading">Действия</th>}</tr></thead>
            <tbody>
              {loading ? <tr><td colSpan={fields.length + (canEdit ? 1 : 0)}><span className="planning-table-state"><LoaderCircle size={17} className="template-spinner" /> Загружаем работы…</span></td></tr>
                : items.length === 0 ? <tr><td colSpan={fields.length + (canEdit ? 1 : 0)}><span className="planning-table-state planning-table-empty"><ClipboardList size={22} />{error ? "Не удалось получить данные." : Object.values(filters).some(Boolean) ? "По заданным фильтрам ничего не найдено." : "Список пока пуст. Добавьте первую работу выше."}</span></td></tr>
                  : items.map((work) => <tr key={work.id}>
                    {fields.map(({ key }) => <td key={key} className={`planning-cell-${key}`} title={work[key] || undefined}>{key === "data" ? formatDate(work[key]) : work[key] || "—"}</td>)}
                    {canEdit && <td className="planning-row-actions"><button type="button" title="Изменить" aria-label={`Изменить работу ${work.id_site}`} onClick={() => beginEdit(work)}><Pencil size={14} /></button><button type="button" title="Удалить" aria-label={`Удалить работу ${work.id_site}`} disabled={deletingId === work.id} onClick={() => void deleteWork(work)}><Trash2 size={14} /></button></td>}
                  </tr>)}
            </tbody>
          </table>
        </div>
        <div className="planning-table-footer"><span>{total > 0 ? `Показано ${((page - 1) * pageSize + 1).toLocaleString("ru-RU")}–${Math.min(page * pageSize, total).toLocaleString("ru-RU")} из ${total.toLocaleString("ru-RU")}` : ""}</span><div><button type="button" aria-label="Предыдущая страница" disabled={page <= 1 || loading} onClick={() => setPage((value) => Math.max(1, value - 1))}><ChevronLeft size={16} /></button><span>Страница {page} из {pageCount}</span><button type="button" aria-label="Следующая страница" disabled={page >= pageCount || loading} onClick={() => setPage((value) => value + 1)}><ChevronRight size={16} /></button></div></div>
      </div>

      <footer className="page-footer"><span>YouGile Operations Portal <span className="footer-version">{PORTAL_VERSION}</span></span><span>Планирование работ</span></footer>
    </section>
  );
}
