import { useCallback, useEffect, useState } from "react";
import { ArrowLeft, CheckCircle2, FileSpreadsheet, LoaderCircle, RefreshCw, Upload } from "lucide-react";
import { apiFetch } from "./apiClient";

type Dataset = "AGGREGATE" | "KPI_REPORT" | "STATUS_CHANGES" | "RESPONSIBLE_CHANGES" | "POLITICS" | "POLITICS_WEEKLY";
type RecentImport = { id: string; fileName: string; dataset: Dataset; rowCount: number; createdAt: string };
type Summary = { counts: Record<string, { rows: number; updatedAt: string | null }>; recentImports: RecentImport[] };
type KpiValues = Record<string, unknown>;

const datasetLabels: Record<Dataset, string> = {
  AGGREGATE: "Реестр обращений",
  KPI_REPORT: "Показатели KPI 1–7",
  STATUS_CHANGES: "История смены статусов",
  RESPONSIBLE_CHANGES: "Смена ответственных",
  POLITICS: "Дневная статистика",
  POLITICS_WEEKLY: "Недельная статистика"
};
const kpiFields = ["KPI-0", "KPI-01", "KPI-02", "KPI-03", "KPI-04", "KPI-05", "KPI-06", "KPI-07"];

function message(error: unknown) {
  return error instanceof Error ? error.message : "Не удалось выполнить запрос.";
}

function formatDate(value: string) {
  return new Date(value).toLocaleString("ru-RU", { dateStyle: "short", timeStyle: "short" });
}

export default function DapsReportPage({ onBack, canEdit }: { onBack: () => void; canEdit: boolean }) {
  const [files, setFiles] = useState<File[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [kpiDate, setKpiDate] = useState("");
  const [kpiValues, setKpiValues] = useState<Record<string, string>>({});
  const [kpiLoaded, setKpiLoaded] = useState(false);
  const [savingKpi, setSavingKpi] = useState(false);

  const loadSummary = useCallback(async () => {
    setLoading(true);
    try {
      const response = await apiFetch("/api/daps/summary");
      const data = await response.json() as Summary & { error?: string };
      if (!response.ok) throw new Error(data.error ?? "Не удалось загрузить данные отчётов.");
      setSummary(data);
    } catch (reason) {
      setError(message(reason));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void loadSummary(); }, [loadSummary]);

  const uploadReports = async () => {
    if (!files.length || uploading) return;
    setUploading(true);
    setError("");
    setNotice("");
    const form = new FormData();
    files.forEach((file) => form.append("reports", file, file.name));
    try {
      const response = await apiFetch("/api/daps/reports", { method: "POST", body: form });
      const data = await response.json() as { error?: string; imported?: { fileName: string; dataset: Dataset; rows: number }[]; kpiZeroDays?: number };
      if (!response.ok) throw new Error(data.error ?? "Не удалось обработать отчёты.");
      const importedRows = (data.imported ?? []).reduce((sum, item) => sum + item.rows, 0);
      setNotice(`Обработано строк: ${importedRows.toLocaleString("ru-RU")}. KPI 0 пересчитан за ${data.kpiZeroDays ?? 0} дней.`);
      setFiles([]);
      const input = document.getElementById("daps-report-files") as HTMLInputElement | null;
      if (input) input.value = "";
      await loadSummary();
    } catch (reason) {
      setError(message(reason));
    } finally {
      setUploading(false);
    }
  };

  const loadKpi = async () => {
    if (!kpiDate) return;
    setError("");
    setNotice("");
    setKpiLoaded(false);
    try {
      const response = await apiFetch(`/api/daps/kpi?date=${encodeURIComponent(kpiDate)}`);
      const data = await response.json() as { error?: string; values?: KpiValues };
      if (!response.ok) throw new Error(data.error ?? "Не удалось загрузить KPI.");
      setKpiValues(Object.fromEntries(kpiFields.map((field) => [field, String(data.values?.[field] ?? "")] )));
      setKpiLoaded(true);
    } catch (reason) {
      setKpiValues({});
      setError(message(reason));
    }
  };

  const saveKpi = async () => {
    if (!kpiLoaded || savingKpi) return;
    setSavingKpi(true);
    setError("");
    setNotice("");
    try {
      const response = await apiFetch(`/api/daps/kpi/${encodeURIComponent(kpiDate)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(kpiValues)
      });
      const data = await response.json() as { error?: string };
      if (!response.ok) throw new Error(data.error ?? "Не удалось сохранить KPI.");
      setNotice(`KPI 1–7 за ${new Date(`${kpiDate}T00:00:00`).toLocaleDateString("ru-RU")} сохранены.`);
      await loadSummary();
    } catch (reason) {
      setError(message(reason));
    } finally {
      setSavingKpi(false);
    }
  };

  return (
    <section className="section-view daps-report-page">
      <div className="eyebrow"><span className="eyebrow-line" /> DAPS · ОТЧЁТЫ</div>
      <div className="section-hero daps-report-hero">
        <span className="section-hero-icon"><FileSpreadsheet size={22} /></span>
        <div><h1>Отчёты Naumen</h1><p>Загрузка отчётов, расчёт KPI 0 и редактирование показателей KPI 1–7.</p></div>
        <button type="button" className="text-button" onClick={onBack}><ArrowLeft size={15} /> Назад</button>
      </div>

      {error && <div className="admin-feedback admin-feedback-error" role="alert">{error}</div>}
      {notice && <div className="admin-feedback admin-feedback-success" role="status"><CheckCircle2 size={15} />{notice}</div>}

      <div className="history-stat-grid admin-stat-grid daps-count-grid">
        <div className="panel history-stat-card"><span className="history-stat-label">Обращений</span><strong>{(summary?.counts.AGGREGATE?.rows ?? 0).toLocaleString("ru-RU")}</strong><small>в реестре Aggregate</small></div>
        <div className="panel history-stat-card history-stat-blue"><span className="history-stat-label">Дней с KPI</span><strong>{(summary?.counts.KPI_REPORT?.rows ?? 0).toLocaleString("ru-RU")}</strong><small>значения за даты</small></div>
        <div className="panel history-stat-card history-stat-violet"><span className="history-stat-label">Смен статусов</span><strong>{(summary?.counts.STATUS_CHANGES?.rows ?? 0).toLocaleString("ru-RU")}</strong><small>события в отчётах</small></div>
        <div className="panel history-stat-card history-stat-green"><span className="history-stat-label">Недельных сводок</span><strong>{(summary?.counts.POLITICS_WEEKLY?.rows ?? 0).toLocaleString("ru-RU")}</strong><small>обновлённых периодов</small></div>
      </div>

      <div className="daps-report-layout">
        <section className="panel daps-report-panel">
          <div className="panel-heading"><div><h2>Загрузить отчёты</h2><p>Выберите один или несколько XLSX-файлов из n8n-формы.</p></div></div>
        <label className={`xlsx-dropzone ${uploading || !canEdit ? "xlsx-dropzone-busy" : ""}`} htmlFor="daps-report-files">
            <Upload size={19} />
            <strong>{files.length ? `Выбрано файлов: ${files.length}` : "Выберите XLSX-отчёты"}</strong>
            <span>Форматы имён: exportSD, DD.MM.YYYY.xlsx, отчёты смены статусов и К3_по неделям</span>
            <input id="daps-report-files" type="file" accept=".xlsx" multiple disabled={uploading || !canEdit} onChange={(event) => setFiles(Array.from(event.target.files ?? []))} />
          </label>
          {files.length > 0 && <ul className="daps-file-list">{files.map((file) => <li key={`${file.name}-${file.size}`}>{file.name}<small>{(file.size / 1024 / 1024).toFixed(1)} МБ</small></li>)}</ul>}
          {canEdit && <div className="daps-actions"><button type="button" className="btn-primary" onClick={() => void uploadReports()} disabled={!files.length || uploading}>{uploading ? <><LoaderCircle size={14} className="template-spinner" /> Обрабатываем…</> : "Загрузить и обработать"}</button></div>}
          <p className="admin-panel-note">Данные обновляются в отдельной базе DAPS. Повторная загрузка обновляет записи по их ключам, а не создаёт дубликаты.</p>
        </section>

        <section className="panel daps-report-panel">
          <div className="panel-heading"><div><h2>Редактировать KPI 0–7</h2><p>KPI-0 сохраняется в дневное значение «KPI-0(MM_day)».</p></div></div>
          <div className="daps-kpi-toolbar">
            <label><span>Дата отчёта</span><input type="date" value={kpiDate} onChange={(event) => { setKpiDate(event.target.value); setKpiLoaded(false); }} /></label>
            <button type="button" className="outline-button" onClick={() => void loadKpi()} disabled={!kpiDate}>Загрузить значения</button>
          </div>
          {kpiLoaded && <div className="daps-kpi-grid">{kpiFields.map((field) => <label key={field}><span>{field}</span><input disabled={!canEdit} value={kpiValues[field] ?? ""} onChange={(event) => setKpiValues((current) => ({ ...current, [field]: event.target.value }))} /></label>)}</div>}
          {kpiLoaded && canEdit && <div className="daps-actions"><button type="button" className="btn-primary" onClick={() => void saveKpi()} disabled={savingKpi}>{savingKpi ? "Сохраняем…" : "Сохранить KPI"}</button></div>}
        </section>
      </div>

      <section className="panel daps-import-history">
        <div className="panel-heading"><div><h2>Последние загрузки</h2><p>История загрузок и количество обработанных строк.</p></div><button type="button" className="icon-button" aria-label="Обновить историю" onClick={() => void loadSummary()} disabled={loading}><RefreshCw size={15} /></button></div>
        {loading ? <div className="admin-loading"><LoaderCircle size={16} className="template-spinner" /> Загружаем…</div> : !summary?.recentImports.length ? <div className="admin-loading">Загрузок пока нет.</div> : (
          <div className="history-table-wrap"><table className="history-table"><thead><tr><th>Файл</th><th>Набор данных</th><th>Строк</th><th>Загружен</th></tr></thead><tbody>
            {summary.recentImports.map((item) => <tr key={item.id}><td>{item.fileName}</td><td>{datasetLabels[item.dataset] ?? item.dataset}</td><td>{item.rowCount.toLocaleString("ru-RU")}</td><td>{formatDate(item.createdAt)}</td></tr>)}
          </tbody></table></div>
        )}
      </section>
    </section>
  );
}
