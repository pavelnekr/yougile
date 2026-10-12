import { useCallback, useEffect, useMemo, useRef, useState, type FocusEvent } from "react";
import {
  ChevronDown,
  ChevronUp,
  Filter,
  LoaderCircle,
  Plus,
  Search,
  Trash2,
  X
} from "lucide-react";
import { apiFetch } from "./apiClient";
import ConfirmDialog from "./ConfirmDialog";
import { countRu, rowForms } from "./plural";

/**
 * Поля строки плана. Порядок и подписи повторяют колонки XLSX, который служит
 * образцом набора колонок: free1, data, day, time, id_site, address, PO, comment,
 * free2, free3, user, comment2, status, klaster.
 */
interface PlanFieldDef {
  key: string;
  label: string;
  type?: "date";
  width: string;
  multiline?: boolean;
}

const PLAN_FIELDS: PlanFieldDef[] = [
  { key: "free1", label: "free1", width: "90px" },
  { key: "planDate", label: "data", type: "date", width: "130px" },
  { key: "shift", label: "day", width: "100px" },
  { key: "timeWindow", label: "time", width: "120px" },
  { key: "siteId", label: "id_site", width: "90px" },
  { key: "address", label: "address", width: "240px", multiline: true },
  { key: "po", label: "PO", width: "90px" },
  { key: "comment", label: "comment", width: "260px", multiline: true },
  { key: "free2", label: "free2", width: "90px" },
  { key: "free3", label: "free3", width: "90px" },
  { key: "engineer", label: "user", width: "160px" },
  { key: "comment2", label: "comment2", width: "260px", multiline: true },
  { key: "status", label: "status", width: "120px" },
  { key: "cluster", label: "klaster", width: "120px" }
];

type PlanFieldKey = PlanFieldDef["key"];

const MAX_ROWS = 3000;
const DEBOUNCE_MS = 250;

/** Ключевые поля, по которым ищут «незаполненные». */
const INCOMPLETE_FIELDS: Array<{ key: string; label: string }> = [
  { key: "siteId", label: "площадка" },
  { key: "address", label: "адрес" },
  { key: "engineer", label: "инженер" },
  { key: "status", label: "статус" }
];

interface PlanRow {
  id: string;
  planDate: string | null;
  shift: string | null;
  timeWindow: string | null;
  siteId: string | null;
  address: string | null;
  po: string | null;
  comment: string | null;
  engineer: string | null;
  comment2: string | null;
  status: string | null;
  cluster: string | null;
  free1: string | null;
  free2: string | null;
  free3: string | null;
  sortOrder: number;
  createdById: string | null;
  createdAt: string;
  updatedAt: string;
}

interface PlanOptions {
  shift: string[];
  engineer: string[];
  status: string[];
  cluster: string[];
  po: string[];
}

interface PlanListResponse {
  items: PlanRow[];
  total: number;
  filtered: number;
  options: PlanOptions;
}

interface Filters {
  q: string;
  dateFrom: string;
  dateTo: string;
  shift: string[];
  time: string;
  siteId: string;
  address: string;
  engineer: string[];
  status: string[];
  cluster: string[];
  po: string[];
  free1: string;
  free2: string;
  free3: string;
  incomplete: string[];
  sort: string;
  dir: "asc" | "desc";
}

const EMPTY_FILTERS: Filters = {
  q: "",
  dateFrom: "",
  dateTo: "",
  shift: [],
  time: "",
  siteId: "",
  address: "",
  engineer: [],
  status: [],
  cluster: [],
  po: [],
  free1: "",
  free2: "",
  free3: "",
  incomplete: [],
  sort: "planDate",
  dir: "asc"
};

function filtersAreEmpty(f: Filters) {
  return (
    !f.q && !f.dateFrom && !f.dateTo && !f.shift.length && !f.time &&
    !f.siteId && !f.address && !f.engineer.length && !f.status.length &&
    !f.cluster.length && !f.po.length && !f.free1 && !f.free2 && !f.free3 &&
    !f.incomplete.length
  );
}

export default function PlanningPage({ canEdit = true }: { canEdit?: boolean } = {}) {
  const [loadState, setLoadState] = useState<"loading" | "ready" | "error">("loading");
  const [refreshing, setRefreshing] = useState(false);
  const [errorText, setErrorText] = useState("");
  const [rows, setRows] = useState<PlanRow[]>([]);
  const [options, setOptions] = useState<PlanOptions>({ shift: [], engineer: [], status: [], cluster: [], po: [] });
  const [total, setTotal] = useState(0);
  const [filtered, setFiltered] = useState(0);
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [saving, setSaving] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const hasLoadedRef = useRef(false);

  const reload = useCallback(() => setReloadToken((n) => n + 1), []);

  const buildQuery = useCallback((f: Filters) => {
    const params = new URLSearchParams();
    if (f.q) params.set("q", f.q);
    if (f.dateFrom) params.set("dateFrom", f.dateFrom);
    if (f.dateTo) params.set("dateTo", f.dateTo);
    if (f.shift.length) params.set("shift", f.shift.join(","));
    if (f.time) params.set("time", f.time);
    if (f.siteId) params.set("siteId", f.siteId);
    if (f.address) params.set("address", f.address);
    if (f.engineer.length) params.set("engineer", f.engineer.join(","));
    if (f.status.length) params.set("status", f.status.join(","));
    if (f.cluster.length) params.set("cluster", f.cluster.join(","));
    if (f.po.length) params.set("po", f.po.join(","));
    if (f.free1) params.set("free1", f.free1);
    if (f.free2) params.set("free2", f.free2);
    if (f.free3) params.set("free3", f.free3);
    if (f.incomplete.length) params.set("incomplete", f.incomplete.join(","));
    params.set("sort", f.sort);
    params.set("dir", f.dir);
    return params.toString();
  }, []);

  // Единая загрузка с дебаунсом: любой ввод в фильтр ждёт паузу, затем идёт
  // один запрос. Пока идёт перезапрос, таблица остаётся на экране.
  useEffect(() => {
    const controller = new AbortController();
    if (hasLoadedRef.current) setRefreshing(true);

    const timer = window.setTimeout(async () => {
      try {
        const response = await apiFetch(`/api/planning/rows?${buildQuery(filters)}`, { signal: controller.signal });
        if (controller.signal.aborted) return;
        const raw = await response.json() as unknown;
        if (!response.ok) {
          const message = raw && typeof raw === "object" && "error" in raw ? String((raw as { error: unknown }).error) : "Не удалось загрузить план.";
          throw new Error(message);
        }
        const data = raw as PlanListResponse;
        if (controller.signal.aborted) return;
        setRows(data.items);
        setOptions(data.options);
        setTotal(data.total);
        setFiltered(data.filtered);
        setErrorText("");
        setLoadState("ready");
        hasLoadedRef.current = true;
      } catch (reason) {
        if (controller.signal.aborted) return;
        setErrorText(reason instanceof Error ? reason.message : "Не удалось загрузить план.");
        setLoadState("error");
      } finally {
        if (!controller.signal.aborted) setRefreshing(false);
      }
    }, DEBOUNCE_MS);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [filters, reloadToken, buildQuery]);

  const activeFilterCount = useMemo(() => {
    let c = 0;
    if (filters.q) c++;
    if (filters.dateFrom || filters.dateTo) c++;
    if (filters.shift.length) c++;
    if (filters.time) c++;
    if (filters.siteId) c++;
    if (filters.address) c++;
    if (filters.engineer.length) c++;
    if (filters.status.length) c++;
    if (filters.cluster.length) c++;
    if (filters.po.length) c++;
    if (filters.free1 || filters.free2 || filters.free3) c++;
    if (filters.incomplete.length) c++;
    return c;
  }, [filters]);

  const quickDatePresets = useMemo(() => {
    const fmt = (d: Date) => new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
    const today = new Date();
    const tomorrow = new Date(today); tomorrow.setDate(tomorrow.getDate() + 1);
    const weekEnd = new Date(today); weekEnd.setDate(weekEnd.getDate() + 7);
    return [
      { label: "Сегодня", from: fmt(today), to: fmt(today) },
      { label: "Завтра", from: fmt(tomorrow), to: fmt(tomorrow) },
      { label: "Неделя", from: fmt(today), to: fmt(weekEnd) },
      { label: "Все", from: "", to: "" }
    ];
  }, []);

  const setFilter = useCallback(<K extends keyof Filters>(key: K, value: Filters[K]) => {
    setFilters((prev) => ({ ...prev, [key]: value }));
  }, []);

  const toggleCsv = useCallback((key: "shift" | "engineer" | "status" | "cluster" | "po", value: string) => {
    setFilters((prev) => {
      const list = prev[key];
      const next = list.includes(value) ? list.filter((v) => v !== value) : [...list, value];
      return { ...prev, [key]: next };
    });
  }, []);

  const toggleIncomplete = useCallback((key: string) => {
    setFilters((prev) => ({
      ...prev,
      incomplete: prev.incomplete.includes(key)
        ? prev.incomplete.filter((v) => v !== key)
        : [...prev.incomplete, key]
    }));
  }, []);

  const handleCreate = useCallback(async () => {
    setCreating(true);
    try {
      const response = await apiFetch("/api/planning/rows", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}"
      });
      const raw = await response.json() as unknown;
      if (!response.ok) {
        const message = raw && typeof raw === "object" && "error" in raw ? String((raw as { error: unknown }).error) : "Не удалось добавить строку.";
        throw new Error(message);
      }
      reload();
    } catch (reason) {
      alert(reason instanceof Error ? reason.message : "Не удалось добавить строку.");
    } finally {
      setCreating(false);
    }
  }, [reload]);

  const handleBlur = useCallback(async (rowId: string, field: PlanFieldKey, value: string) => {
    const current = rows.find((r) => r.id === rowId);
    if (!current) return;
    const before = (current[field as keyof PlanRow] as string | null) ?? null;
    const normalized = value.trim() ? value.trim() : null;
    if (before === normalized) return;

    setRows((prev) => prev.map((r) => (r.id === rowId ? { ...r, [field]: normalized } : r)));
    setSaving(rowId);
    try {
      const response = await apiFetch(`/api/planning/rows/${encodeURIComponent(rowId)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [field]: normalized })
      });
      if (!response.ok) {
        const raw = await response.json() as { error?: string };
        throw new Error(raw.error ?? "Не удалось сохранить.");
      }
      reload();
    } catch (reason) {
      setRows((prev) => prev.map((r) => (r.id === rowId ? { ...r, [field]: before } : r)));
      alert(reason instanceof Error ? reason.message : "Не удалось сохранить.");
    } finally {
      setSaving(null);
    }
  }, [rows, reload]);

  const handleDelete = useCallback(async (id: string) => {
    setDeleting(id);
    try {
      const response = await apiFetch(`/api/planning/rows/${encodeURIComponent(id)}`, { method: "DELETE" });
      if (!response.ok) {
        const raw = await response.json() as { error?: string };
        throw new Error(raw.error ?? "Не удалось удалить строку.");
      }
      setRows((prev) => prev.filter((r) => r.id !== id));
      setTotal((t) => Math.max(0, t - 1));
      setFiltered((t) => Math.max(0, t - 1));
    } catch (reason) {
      alert(reason instanceof Error ? reason.message : "Не удалось удалить строку.");
    } finally {
      setDeleting(null);
      setConfirmDelete(null);
    }
  }, []);

  const handleSort = useCallback((field: string) => {
    setFilters((prev) => ({
      ...prev,
      sort: field,
      dir: prev.sort === field && prev.dir === "asc" ? "desc" : "asc"
    }));
  }, []);

  const renderCell = (row: PlanRow, def: PlanFieldDef) => {
    const value = (row[def.key as keyof PlanRow] as string | null) ?? "";
    const disabled = !canEdit || saving === row.id;
    const commit = (v: string) => { void handleBlur(row.id, def.key, v); };

    const common = {
      key: `${row.id}-${def.key}-${value}`,
      className: "plan-cell-input",
      defaultValue: value,
      disabled,
      onBlur: (e: FocusEvent<HTMLInputElement | HTMLTextAreaElement>) => commit(e.currentTarget.value),
      title: value || undefined
    };

    if (def.type === "date") {
      return <input type="date" {...common} style={{ width: def.width }} />;
    }
    if (def.multiline) {
      return (
        <textarea
          {...common}
          className="plan-cell-input plan-cell-textarea"
          rows={1}
          style={{ width: def.width, minWidth: def.width }}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) e.currentTarget.blur(); }}
        />
      );
    }
    return <input type="text" {...common} style={{ width: def.width }} />;
  };

  const filterPanel = (
    <section className="planning-filters">
      <div className="planning-filters-header">
        <h3><Filter size={16} /> Фильтры {activeFilterCount > 0 && <span className="filter-badge">{activeFilterCount}</span>}</h3>
        <button type="button" className="text-button" onClick={() => setFilters(EMPTY_FILTERS)} disabled={filtersAreEmpty(filters)}>
          <X size={14} /> Сбросить
        </button>
      </div>

      <div className="planning-filters-grid">
        <div className="filter-group filter-group-wide">
          <label htmlFor="plan-q">Поиск по всем полям</label>
          <div className="filter-input-wrap">
            <Search size={14} />
            <input
              id="plan-q"
              type="search"
              placeholder="Площадка, адрес, инженер, комментарий…"
              value={filters.q}
              onChange={(e) => setFilter("q", e.target.value)}
            />
          </div>
        </div>

        <div className="filter-group filter-group-wide">
          <label>Дата плана</label>
          <div className="date-presets">
            {quickDatePresets.map((p) => (
              <button
                key={p.label}
                type="button"
                className={`preset-btn${filters.dateFrom === p.from && filters.dateTo === p.to ? " preset-btn-on" : ""}`}
                onClick={() => setFilters((prev) => ({ ...prev, dateFrom: p.from, dateTo: p.to }))}
              >
                {p.label}
              </button>
            ))}
          </div>
          <div className="date-range">
            <input type="date" value={filters.dateFrom} onChange={(e) => setFilter("dateFrom", e.target.value)} aria-label="Дата с" />
            <span>—</span>
            <input type="date" value={filters.dateTo} onChange={(e) => setFilter("dateTo", e.target.value)} aria-label="Дата по" />
          </div>
        </div>

        <FilterChips label="Смена (day)" options={options.shift} selected={filters.shift} onToggle={(v) => toggleCsv("shift", v)} />

        <div className="filter-group">
          <label htmlFor="plan-time">Время (time)</label>
          <input id="plan-time" type="text" placeholder="00:00-06:00" value={filters.time} onChange={(e) => setFilter("time", e.target.value)} />
        </div>

        <div className="filter-group">
          <label htmlFor="plan-site">Площадка (id_site)</label>
          <input id="plan-site" type="text" placeholder="Номер" value={filters.siteId} onChange={(e) => setFilter("siteId", e.target.value)} />
        </div>

        <div className="filter-group">
          <label htmlFor="plan-address">Адрес</label>
          <input id="plan-address" type="text" placeholder="Часть адреса" value={filters.address} onChange={(e) => setFilter("address", e.target.value)} />
        </div>

        <FilterChips label="Инженер (user)" options={options.engineer} selected={filters.engineer} onToggle={(v) => toggleCsv("engineer", v)} emptyOption />
        <FilterChips label="Статус (status)" options={options.status} selected={filters.status} onToggle={(v) => toggleCsv("status", v)} emptyOption />
        <FilterChips label="Кластер (klaster)" options={options.cluster} selected={filters.cluster} onToggle={(v) => toggleCsv("cluster", v)} emptyOption />
        <FilterChips label="PO" options={options.po} selected={filters.po} onToggle={(v) => toggleCsv("po", v)} />

        <div className="filter-group">
          <label htmlFor="plan-free1">free1</label>
          <input id="plan-free1" type="text" value={filters.free1} onChange={(e) => setFilter("free1", e.target.value)} />
        </div>
        <div className="filter-group">
          <label htmlFor="plan-free2">free2</label>
          <input id="plan-free2" type="text" value={filters.free2} onChange={(e) => setFilter("free2", e.target.value)} />
        </div>
        <div className="filter-group">
          <label htmlFor="plan-free3">free3</label>
          <input id="plan-free3" type="text" value={filters.free3} onChange={(e) => setFilter("free3", e.target.value)} />
        </div>

        <div className="filter-group filter-group-wide">
          <label>Незаполненные поля</label>
          <div className="chips-wrap">
            {INCOMPLETE_FIELDS.map((f) => (
              <label key={f.key} className={`chip${filters.incomplete.includes(f.key) ? " chip-on" : ""}`}>
                <input type="checkbox" checked={filters.incomplete.includes(f.key)} onChange={() => toggleIncomplete(f.key)} />
                <span>{f.label}</span>
              </label>
            ))}
          </div>
        </div>
      </div>
    </section>
  );

  return (
    <div className="planning-page">
      <header className="planning-header">
        <div>
          <h1>Планирование Работ</h1>
          <p className="planning-subtitle">
            План работ по площадкам: правка прямо в таблице, добавление и удаление строк, фильтры по датам,
            смене, площадке, инженеру, статусу и кластеру.
          </p>
        </div>
        {canEdit && (
          <button type="button" className="btn-primary" onClick={() => void handleCreate()} disabled={creating}>
            <Plus size={16} /> {creating ? "Добавляем…" : "Добавить строку"}
          </button>
        )}
      </header>

      {loadState === "loading" && (
        <div className="planning-state"><LoaderCircle size={20} className="spin" /> Загрузка плана…</div>
      )}
      {loadState === "error" && (
        <div className="planning-state planning-state-error">
          <span>{errorText || "Не удалось загрузить план."}</span>
          <button type="button" className="outline-button" onClick={reload}>Повторить</button>
        </div>
      )}

      {loadState === "ready" && (
        <>
          {filterPanel}

          <div className="planning-stats">
            <span>{countRu(filtered, rowForms)}</span>
            {filtered !== total && <span className="muted">из {countRu(total, rowForms)} · фильтры активны</span>}
            {refreshing && <span className="muted"><LoaderCircle size={13} className="spin" /> обновление…</span>}
            {rows.length >= MAX_ROWS && (
              <span className="warn">Показаны первые {MAX_ROWS}. Уточните фильтры, чтобы увидеть остальные.</span>
            )}
          </div>

          <div className="planning-table-wrap">
            <table className="planning-table">
              <thead>
                <tr>
                  {PLAN_FIELDS.map((def) => (
                    <th key={def.key} style={{ width: def.width, minWidth: def.width }}>
                      <button type="button" className="plan-th-button" onClick={() => handleSort(def.key)}>
                        {def.label}
                        {filters.sort === def.key
                          ? (filters.dir === "asc" ? <ChevronUp size={12} /> : <ChevronDown size={12} />)
                          : null}
                      </button>
                    </th>
                  ))}
                  <th className="plan-th-actions" style={{ width: "56px" }}>·</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.id} className={saving === row.id ? "row-saving" : undefined}>
                    {PLAN_FIELDS.map((def) => (
                      <td key={def.key} className="plan-cell">{renderCell(row, def)}</td>
                    ))}
                    <td className="plan-actions">
                      {canEdit && (
                        <button
                          type="button"
                          className="icon-button icon-button-danger"
                          onClick={() => setConfirmDelete(row.id)}
                          disabled={deleting === row.id}
                          title="Удалить строку"
                          aria-label="Удалить строку"
                        >
                          {deleting === row.id ? <LoaderCircle size={14} className="spin" /> : <Trash2 size={14} />}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
                {rows.length === 0 && (
                  <tr>
                    <td colSpan={PLAN_FIELDS.length + 1} className="planning-empty">
                      {filtersAreEmpty(filters)
                        ? "План пуст. Добавьте первую строку."
                        : "По заданным фильтрам строк нет."}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          {confirmDelete && (
            <ConfirmDialog
              title="Удалить строку?"
              confirmLabel={deleting ? "Удаляем…" : "Удалить"}
              onConfirm={() => void handleDelete(confirmDelete)}
              onCancel={() => { if (!deleting) setConfirmDelete(null); }}
            >
              Строка плана будет удалена безвозвратно.
            </ConfirmDialog>
          )}
        </>
      )}
    </div>
  );
}

/** Чипы мультивыбора по значениям из данных, с опцией «(пусто)». */
function FilterChips({ label, options, selected, onToggle, emptyOption = false }: {
  label: string;
  options: string[];
  selected: string[];
  onToggle: (value: string) => void;
  emptyOption?: boolean;
}) {
  return (
    <div className="filter-group">
      <label>
        {label} {selected.length > 0 && <span className="filter-badge">{selected.length}</span>}
      </label>
      <div className="chips-wrap">
        {options.length === 0 && !emptyOption && <span className="chips-empty">нет значений</span>}
        {options.map((opt) => (
          <label key={opt} className={`chip${selected.includes(opt) ? " chip-on" : ""}`}>
            <input type="checkbox" checked={selected.includes(opt)} onChange={() => onToggle(opt)} />
            <span>{opt}</span>
          </label>
        ))}
        {emptyOption && (
          <label className={`chip${selected.includes("__empty__") ? " chip-on" : ""}`}>
            <input type="checkbox" checked={selected.includes("__empty__")} onChange={() => onToggle("__empty__")} />
            <span className="empty-chip">(пусто)</span>
          </label>
        )}
      </div>
    </div>
  );
}
