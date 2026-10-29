import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, Download, FileSpreadsheet, RefreshCw, Search } from "lucide-react";
import { apiFetch } from "./apiClient";

type BlockRow = Record<"siteCode" | "eventTs" | "filterIp" | "localIp" | "localPort" | "remoteIp" | "remotePort" | "objectId" | "behaviour" | "type" | "protocol" | "extractedSNI", string>;
type SearchResult = { resource: string };
type ProcessResult = { resource: string; total: number; rows: BlockRow[] };

const fields: { key: keyof BlockRow; label: string }[] = [
  { key: "siteCode", label: "Код сайта" }, { key: "eventTs", label: "Время события" }, { key: "filterIp", label: "Filter IP" },
  { key: "localIp", label: "Local IP" }, { key: "localPort", label: "Local Port" }, { key: "remoteIp", label: "Remote IP" },
  { key: "remotePort", label: "Remote Port" }, { key: "objectId", label: "Object ID" }, { key: "behaviour", label: "Behaviour" },
  { key: "type", label: "Тип" }, { key: "protocol", label: "Протокол" }, { key: "extractedSNI", label: "SNI" }
];

export default function LtpBlocksLogPage({ onBack, canEdit }: { onBack: () => void; canEdit: boolean }) {
  const [query, setQuery] = useState("");
  const [resources, setResources] = useState<SearchResult[]>([]);
  const [resource, setResource] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [result, setResult] = useState<ProcessResult | null>(null);
  const [protocol, setProtocol] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<"search" | "process" | "export" | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (query.trim().length < 3) { setResources([]); return; }
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      apiFetch(`/api/ltp/blocks-log/resources?q=${encodeURIComponent(query.trim())}`, { signal: controller.signal })
        .then(async (response) => {
          const data = await response.json() as SearchResult[] | { error?: string };
          if (!response.ok) throw new Error("error" in data ? data.error : "Не удалось выполнить поиск.");
          setResources(data as SearchResult[]);
        }).catch((cause: unknown) => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "Ошибка поиска."); });
    }, 300);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [query]);

  const summary = useMemo(() => Object.entries((result?.rows ?? []).reduce<Record<string, number>>((counts, row) => {
    const name = row.protocol.trim() || "Unknown";
    counts[name] = (counts[name] ?? 0) + 1;
    return counts;
  }, {})), [result]);
  const visibleRows = result?.rows.filter((row) => protocol === null || (row.protocol.trim() || "Unknown") === protocol) ?? [];

  const processFile = async () => {
    if (!resource || !file || busy) return;
    setBusy("process"); setError(""); setResult(null); setProtocol(null);
    try {
      const form = new FormData(); form.append("report_file", file);
      const response = await apiFetch(`/api/ltp/blocks-log/process?resource=${encodeURIComponent(resource)}`, { method: "POST", body: form });
      const data = await response.json() as ProcessResult & { error?: string };
      if (!response.ok) throw new Error(data.error ?? "Не удалось обработать файл.");
      setResult(data);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Не удалось обработать файл."); }
    finally { setBusy(null); }
  };

  const exportExcel = async () => {
    if (!result || busy) return;
    setBusy("export"); setError("");
    try {
      const response = await apiFetch("/api/ltp/blocks-log/export", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ resource: result.resource, rows: visibleRows }) });
      if (!response.ok) { const data = await response.json() as { error?: string }; throw new Error(data.error ?? "Не удалось подготовить Excel."); }
      const blob = await response.blob(); const url = URL.createObjectURL(blob); const link = document.createElement("a");
      link.href = url; link.download = `Журнал_блокировок_1ЛТП_${result.resource}.xlsx`; link.click(); URL.revokeObjectURL(url);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Не удалось подготовить Excel."); }
    finally { setBusy(null); }
  };

  return <section className="section-view ltp-blocks-page">
    <div className="eyebrow"><span className="eyebrow-line" /> 1ЛТП</div>
    <div className="section-hero"><span className="section-hero-icon"><FileSpreadsheet size={22} /></span><div><h1>Журнал блокировок 1ЛТП</h1><p>Выберите ресурс и загрузите CSV-отчёт для анализа блокировок.</p></div><button type="button" className="text-button" onClick={onBack}><ArrowLeft size={15} /> Назад</button></div>
    <section className="panel ltp-blocks-form">
      <label className="field-label">Ресурс
        <input value={query} list="ltp-resource-list" minLength={3} placeholder="Начните вводить название ресурса" onChange={(event) => { setQuery(event.target.value); setResource(event.target.value); }} />
        <datalist id="ltp-resource-list">{resources.map((item) => <option key={item.resource} value={item.resource} />)}</datalist>
      </label>
      <div className="field-label">CSV-отчёт
        <div className="ltp-file-picker">
          <input ref={fileInput} type="file" accept=".csv,text/csv" onChange={(event) => setFile(event.target.files?.[0] ?? null)} />
          <button type="button" className="outline-button" onClick={() => fileInput.current?.click()}>Выберите файл</button>
          <span className="ltp-file-name">{file?.name ?? "Файл не выбран"}</span>
        </div>
      </div>
      <button type="button" className="btn-primary" disabled={!canEdit || !resource.trim() || !file || busy !== null} onClick={() => void processFile()}><Search size={15} />{busy === "process" ? "Обрабатываем…" : "Запустить обработку"}</button>
      {!canEdit && <span className="ltp-blocks-hint">Для загрузки отчёта нужны права оператора.</span>}
    </section>
    {error && <div className="assignment-error" role="alert">{error}</div>}
    {result && <>
      <section className="section-heading ltp-blocks-results-heading"><div><h2>Аналитика журнала блокировок</h2><p>Ресурс: {result.resource} · найдено строк: {result.total.toLocaleString("ru-RU")}</p></div><button type="button" className="outline-button" disabled={busy !== null} onClick={() => void exportExcel()}><Download size={15} />{busy === "export" ? "Готовим файл…" : "Выгрузить в Excel"}</button></section>
      <div className="panel ltp-blocks-summary"><div className="panel-heading"><div><h2>Сводная статистика по протоколам</h2><p>Нажмите «Фильтровать», чтобы показать строки выбранного протокола.</p></div><button type="button" className="text-button" onClick={() => setProtocol(null)}><RefreshCw size={14} /> Показать все</button></div>
        <div className="ltp-blocks-summary-list">{summary.map(([name, count]) => <div className={`ltp-blocks-summary-row ${name.toLowerCase().includes("white") ? "is-white" : count > 50 ? "is-high" : ""}`} key={name}><strong>{name}</strong><span>{count.toLocaleString("ru-RU")}</span><button type="button" className="text-button" onClick={() => setProtocol(name)}>{protocol === name ? "Выбрано" : "Фильтровать"}</button></div>)}{summary.length === 0 && <p className="table-empty">Подходящих записей не найдено.</p>}</div>
      </div>
      <div className="ltp-blocks-table-wrap"><table className="data-table"><thead><tr>{fields.map((field) => <th key={field.key}>{field.label}</th>)}</tr></thead><tbody>{visibleRows.map((row, index) => <tr key={`${row.objectId}-${index}`}>{fields.map(({ key }) => <td key={key}>{row[key] || "—"}</td>)}</tr>)}{visibleRows.length === 0 && <tr><td className="table-empty" colSpan={fields.length}>Нет строк для отображения.</td></tr>}</tbody></table></div>
    </>}
  </section>;
}
