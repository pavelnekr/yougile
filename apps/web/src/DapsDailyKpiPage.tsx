import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowLeft, CheckCircle2, ChevronDown, ImageDown, LoaderCircle, RefreshCw, Save, TrendingUp } from "lucide-react";
import { apiFetch } from "./apiClient";
import { PORTAL_VERSION } from "./version";

type Values = Record<string, unknown>;
type DailyData = { date: string; values: Values | null; monthlyAverages: Values; monthLabel: string };
type ChartRow = { date: string; values: Values };
type KpiField = { code: string; title: string; target: number; minimum: number; greater: boolean };

const fields: KpiField[] = [
  { code: "KPI-01", title: "Эффективность ограничения доступа к VPN-сервисам с учетом их популярности", target: 85, minimum: 75, greater: true },
  { code: "KPI-02", title: "Доля времени эффективного ограничения популярных VPN-сервисов", target: 85, minimum: 75, greater: true },
  { code: "KPI-03", title: "Доля нефильтрованного трафика по причинам АВР и пуско-наладочных работ", target: 1.5, minimum: 2.5, greater: false },
  { code: "KPI-04", title: "Эффективность ограничения VPN-сервисов на аппаратных платформах", target: 85, minimum: 75, greater: true },
  { code: "KPI-05", title: "Эффективность ограничения VPN-сервисов, для которых разработаны сигнатуры", target: 85, minimum: 75, greater: true },
  { code: "KPI-06", title: "Эффективность средств фрагментации трафика", target: 85, minimum: 75, greater: true },
  { code: "KPI-07", title: "Эффективность ограничения мессенджеров", target: 95, minimum: 85, greater: true }
];

function localDate(date = new Date()) {
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}
function yesterdayDate() {
  const date = new Date();
  date.setDate(date.getDate() - 1);
  return localDate(date);
}
function numeric(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(String(value).replace(",", "."));
  return Number.isFinite(parsed) ? parsed : null;
}
function display(value: number | null) { return value === null ? "—" : value.toLocaleString("ru-RU", { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
function status(daily: number | null, average: number | null, field: KpiField) {
  const classify = (value: number | null) => value === null ? null : field.greater
    ? value >= field.target ? "ok" : value >= field.minimum ? "warning" : "bad"
    : value <= field.target ? "ok" : value <= field.minimum ? "warning" : "bad";
  const d = classify(daily); const m = classify(average);
  if (!d && !m) return { label: "—", className: "empty" };
  const result = d === "bad" || m === "bad" ? "bad" : d === "warning" || m === "warning" ? "warning" : "ok";
  return { label: result === "ok" ? "Выполнено" : "Критично", className: result };
}

export default function DapsDailyKpiPage({ onBack, canEdit }: { onBack: () => void; canEdit: boolean }) {
  const [date, setDate] = useState(yesterdayDate());
  const [data, setData] = useState<DailyData | null>(null);
  const [chart, setChart] = useState<ChartRow[]>([]);
  const [period, setPeriod] = useState<"week" | "month" | "all">("month");
  const [customOpen, setCustomOpen] = useState(false);
  const [custom, setCustom] = useState<Record<string, string>>({});
  const [k0Fact, setK0Fact] = useState("");
  const [k0Accum, setK0Accum] = useState("");
  const [k3Accum, setK3Accum] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const load = useCallback(async () => {
    setLoading(true); setError(""); setNotice("");
    try {
      const [dailyResponse, chartResponse] = await Promise.all([
        apiFetch(`/api/daps/daily-kpi?date=${encodeURIComponent(date)}`),
        apiFetch("/api/daps/daily-kpi/chart")
      ]);
      const dailyBody = await dailyResponse.json();
      const chartBody = await chartResponse.json();
      if (!dailyResponse.ok) throw new Error(dailyBody.error ?? "Не удалось загрузить отчёт.");
      if (!chartResponse.ok) throw new Error(chartBody.error ?? "Не удалось загрузить историю KPI.");
      const next = dailyBody as DailyData;
      setData(next); setChart(chartBody as ChartRow[]);
      const values = next.values ?? {};
      setK0Fact(String(values["KPI-0(MM_day)"] ?? ""));
      setK0Accum(String(values["KPI-0(MM_mounth)"] ?? ""));
      setK3Accum(String(values["KPI-03(CUMM)"] ?? ""));
      const nextCustom: Record<string, string> = {};
      for (const field of fields) {
        const daily = numeric(values[field.code]);
        const average = numeric(next.monthlyAverages[field.code]);
        nextCustom[`${field.code}:daily`] = daily === null ? "" : String(daily);
        nextCustom[`${field.code}:average`] = average === null ? "" : String(average);
      }
      setCustom(nextCustom);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Не удалось загрузить ежедневный отчёт.");
      setData(null);
    } finally { setLoading(false); }
  }, [date]);

  useEffect(() => { void load(); }, [load]);

  const save = async () => {
    const values = [k0Fact, k0Accum, k3Accum].map((value) => Number(value.replace(",", ".")));
    if (values.some((value) => !Number.isFinite(value) || value < 0)) { setError("Введите неотрицательные числа для К0 и накопленного К3."); return; }
    setSaving(true); setError(""); setNotice("");
    try {
      const response = await apiFetch(`/api/daps/daily-kpi/${encodeURIComponent(date)}`, {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ k0Fact: values[0], k0Accum: values[1], k3Accum: values[2] })
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "Не удалось сохранить показатели.");
      setNotice("Показатели сохранены."); await load();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Не удалось сохранить показатели."); }
    finally { setSaving(false); }
  };

  const exportTablePng = async () => {
    const table = document.querySelector<HTMLTableElement>(".daps-daily-table");
    if (!table) return;
    setExporting(true); setError("");
    try {
      await document.fonts.ready;
      const rows = Array.from(table.rows);
      const baseWidths = [82, 0, 105, 115, 125, 150, 112];
      const columnWidths = [...baseWidths];
      const cells = rows.map((row) => Array.from(row.cells));
      const cellText = (cell: HTMLTableCellElement) => {
        const child = cell.children.length === 1 ? cell.firstElementChild as HTMLElement : null;
        return { child, text: (child?.innerText ?? cell.innerText).trim() };
      };
      const canvas = document.createElement("canvas");
      const scale = 2;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("Браузер не смог подготовить изображение.");
      for (const row of cells) {
        row.forEach((cell, columnIndex) => {
          const cellStyle = window.getComputedStyle(cell);
          const { child, text } = cellText(cell);
          const textStyle = window.getComputedStyle(child ?? cell);
          context.font = textStyle.font || `${textStyle.fontWeight} ${textStyle.fontSize} ${textStyle.fontFamily}`;
          const childStyle = child ? window.getComputedStyle(child) : null;
          const extraPadding = childStyle
            ? (Number.parseFloat(childStyle.paddingLeft) || 0) + (Number.parseFloat(childStyle.paddingRight) || 0)
            : 0;
          const needed = context.measureText(text).width
            + (Number.parseFloat(cellStyle.paddingLeft) || 0)
            + (Number.parseFloat(cellStyle.paddingRight) || 0)
            + extraPadding + 10;
          columnWidths[columnIndex] = Math.max(columnWidths[columnIndex] ?? 120, needed);
        });
      }
      // Ширина колонки наименования подстраивается под самую длинную строку,
      // поэтому текст остаётся в одну строку без лишнего пустого места.
      columnWidths[1] = Math.max(columnWidths[1] ?? 0, 1);
      const rowHeights = cells.map((row, index) => {
        const contentHeight = Math.max(...row.map((cell) => {
          const style = window.getComputedStyle(cell);
          return (Number.parseFloat(style.fontSize) || 10) * 1.5
            + (Number.parseFloat(style.paddingTop) || 0) + (Number.parseFloat(style.paddingBottom) || 0);
        }), 34);
        return Math.ceil(Math.max(index === 0 ? 40 : 42, contentHeight));
      });
      const width = Math.ceil(columnWidths.reduce((sum, value) => sum + value, 0));
      const height = Math.ceil(rowHeights.reduce((sum, value) => sum + value, 0));
      canvas.width = width * scale; canvas.height = height * scale;
      context.scale(scale, scale);
      context.fillStyle = "#fff"; context.fillRect(0, 0, width, height);
      let y = 0;
      rows.forEach((_row, rowIndex) => {
        let x = 0;
        cells[rowIndex]?.forEach((cell, columnIndex) => {
        const cellWidth = columnWidths[columnIndex] ?? 120;
        const cellHeight = rowHeights[rowIndex] ?? 42;
        const cellStyle = window.getComputedStyle(cell);
        const background = cellStyle.backgroundColor;
        if (background !== "rgba(0, 0, 0, 0)" && background !== "transparent") {
          context.fillStyle = background; context.fillRect(x, y, cellWidth, cellHeight);
        }
        context.strokeStyle = cellStyle.borderBottomColor || "#edf0f4";
        context.lineWidth = 1; context.strokeRect(x + .5, y + .5, Math.max(0, cellWidth - 1), Math.max(0, cellHeight - 1));
        const { child, text } = cellText(cell);
        const textElement = child ?? cell;
        const textStyle = window.getComputedStyle(textElement);
        context.font = textStyle.font || `${textStyle.fontWeight} ${textStyle.fontSize} ${textStyle.fontFamily}`;
        context.fillStyle = textStyle.color || "#445066";
        if (!text) { x += cellWidth; return; }
        const paddingLeft = Number.parseFloat(cellStyle.paddingLeft) || 0;
        const paddingRight = Number.parseFloat(cellStyle.paddingRight) || 0;
        const paddingTop = Number.parseFloat(cellStyle.paddingTop) || 0;
        const paddingBottom = Number.parseFloat(cellStyle.paddingBottom) || 0;
        const childStyle = child ? window.getComputedStyle(child) : null;
        const childPaddingX = childStyle ? (Number.parseFloat(childStyle.paddingLeft) || 0) + (Number.parseFloat(childStyle.paddingRight) || 0) : 0;
        const fontSize = Number.parseFloat(textStyle.fontSize) || 10;
        const contentHeight = cellHeight - paddingTop - paddingBottom;
        let textY = y + paddingTop + Math.max(0, (contentHeight - fontSize) / 2);
        const align = cellStyle.textAlign;
        const textWidth = context.measureText(text).width;
        let textX = x + paddingLeft;
        if (align === "center") textX = x + (cellWidth - textWidth) / 2;
        if (align === "right" || align === "end") textX = x + cellWidth - paddingRight - textWidth;
        if (childStyle) {
          const pillWidth = Math.min(cellWidth - paddingLeft - paddingRight, textWidth + childPaddingX);
          const pillHeight = Math.min(contentHeight, fontSize * 1.7);
          const pillX = align === "center" ? x + (cellWidth - pillWidth) / 2 : textX - (Number.parseFloat(childStyle.paddingLeft) || 0);
          const pillY = y + paddingTop + Math.max(0, (contentHeight - pillHeight) / 2);
          if (childStyle.backgroundColor !== "rgba(0, 0, 0, 0)" && childStyle.backgroundColor !== "transparent") {
            context.fillStyle = childStyle.backgroundColor; context.beginPath(); context.roundRect(pillX, pillY, pillWidth, pillHeight, pillHeight / 2); context.fill();
          }
          if (childStyle.borderColor && childStyle.borderStyle !== "none") {
            context.strokeStyle = childStyle.borderColor; context.lineWidth = Number.parseFloat(childStyle.borderWidth) || 1;
            context.beginPath(); context.roundRect(pillX, pillY, pillWidth, pillHeight, pillHeight / 2); context.stroke();
          }
          context.fillStyle = textStyle.color || "#445066";
          textY = pillY + (pillHeight - fontSize) / 2;
        }
        context.fillText(text, textX, textY + fontSize * .9);
        x += cellWidth;
        });
        y += rowHeights[rowIndex] ?? 42;
      });
      const png = await new Promise<Blob>((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("Не удалось сформировать PNG.")), "image/png"));
      let copiedToClipboard = false;
      if (navigator.clipboard?.write && typeof ClipboardItem !== "undefined") {
        try {
          await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
          copiedToClipboard = true;
        } catch {
          // В небезопасном контексте или при запрете браузера оставляем скачивание доступным.
        }
      }
      const link = document.createElement("a");
      const downloadUrl = URL.createObjectURL(png);
      link.href = downloadUrl; link.download = `ежедневный-отчет-kpi-${date}.png`;
      link.click(); window.setTimeout(() => URL.revokeObjectURL(downloadUrl), 1000);
      setNotice(copiedToClipboard
        ? "PNG скачан и скопирован в буфер обмена."
        : "PNG скачан. Браузер не разрешил скопировать изображение в буфер обмена.");
    } catch (cause) {
      setError(cause instanceof Error ? `Не удалось создать PNG: ${cause.message}` : "Не удалось создать PNG таблицы.");
    } finally {
      setExporting(false);
    }
  };

  const chartRows = useMemo(() => {
    let rows = chart;
    if (period === "month") rows = rows.filter((row) => row.date.slice(0, 7) === date.slice(0, 7));
    if (period === "week") {
      const selected = new Date(`${date}T00:00:00Z`).getTime();
      rows = rows.filter((row) => { const time = new Date(`${row.date}T00:00:00Z`).getTime(); return time >= selected - 6 * 86400000 && time <= selected; });
    }
    return rows.slice(-120);
  }, [chart, date, period]);
  const selectedMonth = new Date(`${date}T00:00:00Z`).toLocaleDateString("ru-RU", { month: "long", timeZone: "UTC" });
  const selectedMonthLabel = selectedMonth.charAt(0).toLocaleUpperCase("ru-RU") + selectedMonth.slice(1);

  const graph = useMemo(() => {
    if (!chartRows.length) return null;
    const series = [
      { key: "KPI-03", name: "КПЭ общий", color: "#3f5fc5" },
      { key: "KPI-03(PNR)", name: "КПЭ ПНР", color: "#5796c8" },
      { key: "KPI-03(AVR)", name: "КПЭ АВР", color: "#d78a57" },
      { key: "KPI-03(CUMM)", name: "Накопленный К3", color: "#489273" }
    ];
    const values = chartRows.flatMap((row) => series.map((item) => numeric(row.values[item.key])).filter((value): value is number => value !== null));
    const min = Math.min(0, ...values); const max = Math.max(1.5, ...values); const range = max - min || 1;
    const points = (key: string) => chartRows.map((row, index) => {
      const value = numeric(row.values[key]);
      return value === null ? null : `${40 + (index / Math.max(1, chartRows.length - 1)) * 920},${260 - ((value - min) / range) * 220}`;
    }).filter((value): value is string => value !== null).join(" ");
    return { series, points, min, max };
  }, [chartRows]);

  return <section className="section-view daps-report-page daps-daily-kpi-page">
    <div className="eyebrow"><span className="eyebrow-line" /> DAPS · ЕЖЕДНЕВНЫЙ ОТЧЁТ</div>
    <div className="section-hero daps-report-hero">
      <span className="section-hero-icon"><TrendingUp size={22} /></span>
      <div><h1>Ежедневный отчет по KPI</h1><p>Фактические показатели, месячные средние и динамика КПЭ К3.</p></div>
      <button type="button" className="text-button" onClick={onBack}><ArrowLeft size={15} /> Назад</button>
    </div>

    {error && <div className="admin-feedback admin-feedback-error" role="alert">{error}</div>}
    {notice && <div className="admin-feedback admin-feedback-success" role="status"><CheckCircle2 size={15} />{notice}</div>}

    <section className="panel daps-daily-controls">
      <label className="field-label">Дата отчёта<input type="date" value={date} onChange={(event) => setDate(event.target.value)} /></label>
      <button type="button" className="outline-button" onClick={() => void load()} disabled={loading}>{loading ? <LoaderCircle size={14} className="template-spinner" /> : <RefreshCw size={14} />} Обновить</button>
      <label>К0 · факт, мин<input type="number" min="0" step="0.01" value={k0Fact} disabled={!canEdit} onChange={(event) => setK0Fact(event.target.value)} /></label>
      <label>К0 · накопленный факт, мин<input type="number" min="0" step="0.01" value={k0Accum} disabled={!canEdit} onChange={(event) => setK0Accum(event.target.value)} /></label>
      <label>К3 · накопленный факт, %<input type="number" min="0" step="0.01" value={k3Accum} disabled={!canEdit} onChange={(event) => setK3Accum(event.target.value)} /></label>
      {canEdit && <button type="button" className="btn-primary daps-daily-save" onClick={() => void save()} disabled={saving}>{saving ? <LoaderCircle size={14} className="template-spinner" /> : <Save size={14} />}{saving ? "Сохраняем…" : "Сохранить"}</button>}
      <span className="daps-daily-source">{data?.monthLabel ? `Среднее за ${data.monthLabel}` : "Данные загружаются из отчётов DAPS"}</span>
    </section>

    <section className="panel daps-daily-table-panel">
      <div className="panel-heading"><div><h2>Показатели</h2><p>Значения за день сравниваются с целевыми и минимальными порогами.</p></div>
        <div className="daps-report-heading-actions"><button type="button" className="outline-button" onClick={() => void exportTablePng()} disabled={exporting || loading}>{exporting ? <LoaderCircle size={14} className="template-spinner" /> : <ImageDown size={14} />}{exporting ? "Создаём PNG…" : "Скачать PNG"}</button>
          <button type="button" className="text-button" onClick={() => setCustomOpen((open) => !open)}>{customOpen ? "Скрыть ручной ввод" : "Ручной ввод"}<ChevronDown size={14} className={customOpen ? "daps-chevron-open" : ""} /></button></div>
      </div>
      {customOpen && <div className="daps-manual-grid">{fields.map((field) => <div className="daps-manual-row" key={field.code}><strong>{field.code}</strong><label>Факт<input type="number" step="0.01" value={custom[`${field.code}:daily`] ?? ""} onChange={(event) => setCustom((current) => ({ ...current, [`${field.code}:daily`]: event.target.value }))} /></label><label>Среднее<input type="number" step="0.01" value={custom[`${field.code}:average`] ?? ""} onChange={(event) => setCustom((current) => ({ ...current, [`${field.code}:average`]: event.target.value }))} /></label></div>)}</div>}
      <div className="daps-daily-table-wrap"><table className="daps-daily-table"><thead><tr><th>Показатель</th><th>Наименование показателя</th><th>Целевое значение</th><th>Минимальное значение</th><th>Факт за {new Date(`${date}T00:00:00Z`).toLocaleDateString("ru-RU", { dateStyle: "short", timeZone: "UTC" })}</th><th>Накопленный факт {selectedMonthLabel}</th><th>Статус</th></tr></thead>
        <tbody>
          <tr><td><span className="kpi-code">К0</span></td><td>Время регистрации обращений первой линией технической поддержки</td><td>≤ 15 мин</td><td>—</td><td>{display(numeric(k0Fact))} мин</td><td>{display(numeric(k0Accum))} мин</td><td><span className={`daps-kpi-status ${numeric(k0Fact) !== null && numeric(k0Fact)! <= 15 && (numeric(k0Accum) === null || numeric(k0Accum)! <= 15) ? "ok" : numeric(k0Fact) === null && numeric(k0Accum) === null ? "empty" : "bad"}`}>{numeric(k0Fact) === null && numeric(k0Accum) === null ? "Нет данных" : numeric(k0Fact) !== null && numeric(k0Fact)! <= 15 && (numeric(k0Accum) === null || numeric(k0Accum)! <= 15) ? "Выполнено" : "Критично"}</span></td></tr>
          {fields.map((field) => {
            const daily = customOpen ? numeric(custom[`${field.code}:daily`]) : numeric(data?.values?.[field.code]);
            const average = customOpen ? numeric(custom[`${field.code}:average`]) : numeric(data?.monthlyAverages?.[field.code]);
            const accumulated = field.code === "KPI-03" ? numeric(k3Accum) : average;
            const state = status(daily, average, field);
            return <tr key={field.code}><td><span className="kpi-code">К{field.code.slice(-2).replace(/^0/, "")}</span></td><td>{field.title}</td><td>{field.greater ? "≥" : "≤"}{field.target.toLocaleString("ru-RU")} %</td><td>{field.greater ? "≥" : "≤"}{field.minimum.toLocaleString("ru-RU")} %</td><td>{display(daily)} %</td><td>{display(accumulated)} %</td><td><span className={`daps-kpi-status ${state.className}`}>{state.label}</span></td></tr>;
          })}
        </tbody></table></div>
    </section>

    <section className="panel daps-daily-chart-panel"><div className="panel-heading"><div><h2>Динамика КПЭ К3</h2><p>Общий показатель, ПНР, АВР и накопленное значение.</p></div><div className="daps-chart-period">{(["week", "month", "all"] as const).map((item) => <button type="button" className={period === item ? "active" : ""} key={item} onClick={() => setPeriod(item)}>{item === "week" ? "Неделя" : item === "month" ? "Месяц" : "Всё время"}</button>)}</div></div>
      {graph ? <><div className="daps-chart-plot"><svg viewBox="0 0 1000 300" role="img" aria-label="График динамики КПЭ К3"><line x1="40" y1="260" x2="960" y2="260" /><line x1="40" y1="40" x2="40" y2="260" /><text x="4" y="48">{display(graph.max)}%</text><text x="4" y="260">{display(graph.min)}%</text>{graph.series.map((item) => <polyline key={item.key} points={graph.points(item.key)} fill="none" stroke={item.color} strokeWidth="3" strokeLinejoin="round" strokeLinecap="round" />)}</svg></div><div className="daps-chart-legend">{graph.series.map((item) => <span key={item.key}><i style={{ background: item.color }} />{item.name}</span>)}</div><p className="daps-chart-dates">{chartRows[0]?.date} — {chartRows[chartRows.length - 1]?.date} · {chartRows.length} дней</p></> : <div className="daps-chart-empty">Для выбранного периода пока нет данных KPI.</div>}
    </section>
    <footer className="page-footer"><span>YouGile Operations Portal <span className="footer-version">{PORTAL_VERSION}</span></span><span>Портал управления операциями</span></footer>
  </section>;
}
