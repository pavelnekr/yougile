import { useCallback, useEffect, useState } from "react";
import { CheckCircle2, Info, LoaderCircle, Plus, Save, SlidersHorizontal, Trash2 } from "lucide-react";
import { apiFetch } from "./apiClient";
import { columnForms, countRu } from "./plural";
import { PORTAL_VERSION } from "./version";

type PortalColumn = { id: string; name: string };
type LoadState = "loading" | "ready" | "error";
type TabKey = "filter" | "avr";

// ID колонки YouGile — UUID. Как и на бэкенде, сверяем только форму записи,
// без проверки версии: важен сам идентификатор, а не какая версия UUID.
const columnIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const maxColumns = 100;

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
 * Конфигурация портала: ID столбцов YouGile. Раздел виден только администраторам,
 * роль проверена и в меню (App.tsx), и в API (requireRole).
 *
 * Два подраздела: «Фильтрация» — единственный столбец, из которого реально
 * грузится план (его смена применяется сразу), и «АВР» — список добавляемых
 * администратором ID, который пока только хранится.
 */
export default function PortalConfigPage({ onPlanColumnChanged }: { onPlanColumnChanged?: () => void }) {
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [loadError, setLoadError] = useState("");
  const [tab, setTab] = useState<TabKey>("filter");

  const [plan, setPlan] = useState<PortalColumn>({ id: "", name: "" });
  const [savedPlan, setSavedPlan] = useState<PortalColumn>({ id: "", name: "" });
  const [avr, setAvr] = useState<PortalColumn[]>([]);
  const [savedAvr, setSavedAvr] = useState<PortalColumn[]>([]);

  const [savingPlan, setSavingPlan] = useState(false);
  const [savingAvr, setSavingAvr] = useState(false);
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
      setLoadState("ready");
    } catch (reason) {
      if (signal?.aborted) return;
      setLoadError(errorMessage(reason));
      setLoadState("error");
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const planChanged = plan.id !== savedPlan.id || plan.name !== savedPlan.name;
  const avrChanged = JSON.stringify(avr) !== JSON.stringify(savedAvr);

  const switchTab = (nextTab: TabKey) => {
    setTab(nextTab);
    setError("");
    setNotice("");
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
      setNotice("Столбец «Фильтрация» сохранён. Обзор уже перечитывает список площадок из новой колонки.");
      onPlanColumnChanged?.();
    } catch (reason) {
      setError(errorMessage(reason));
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
      setNotice("Столбцы АВР сохранены.");
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setSavingAvr(false);
    }
  };

  const updateAvrColumn = (index: number, patch: Partial<PortalColumn>) => {
    setError("");
    setNotice("");
    setAvr((current) => current.map((column, position) => position === index ? { ...column, ...patch } : column));
  };

  const removeAvrColumn = (index: number) => {
    setError("");
    setNotice("");
    setAvr((current) => current.filter((_, position) => position !== index));
  };

  const addAvrColumn = () => {
    setError("");
    setNotice("");
    setAvr((current) => [...current, { id: "", name: "" }]);
  };

  return (
    <section className="section-view portal-config-page">
      <div className="eyebrow"><span className="eyebrow-line" /> ТОЛЬКО ДЛЯ АДМИНИСТРАТОРА</div>
      <div className="section-hero">
        <span className="section-hero-icon"><SlidersHorizontal size={22} /></span>
        <div>
          <h1>Конфигурация портала</h1>
          <p>Столбцы YouGile: плановый столбец «Фильтрация» и добавляемые столбцы АВР. Изменения вступают в силу после сохранения.</p>
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
                <input
                  id="portal-config-plan-id"
                  value={plan.id}
                  maxLength={36}
                  disabled={savingPlan}
                  placeholder="11111111-1111-4111-8111-111111111111"
                  onChange={(event) => { setPlan((current) => ({ ...current, id: event.target.value })); setNotice(""); }}
                />
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
                  onClick={() => { setPlan(savedPlan); setError(""); setNotice(""); }}
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
                      <input
                        value={column.id}
                        maxLength={36}
                        disabled={savingAvr}
                        placeholder="00000000-0000-0000-0000-000000000000"
                        aria-label={`ID столбца, строка ${index + 1}`}
                        onChange={(event) => updateAvrColumn(index, { id: event.target.value })}
                      />
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
                  onClick={() => { setAvr(savedAvr); setError(""); setNotice(""); }}
                >
                  Отменить
                </button>
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
