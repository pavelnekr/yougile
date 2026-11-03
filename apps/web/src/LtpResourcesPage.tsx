import { useRef, useState } from "react";
import { ArrowLeft, FileSpreadsheet, Upload } from "lucide-react";
import { apiFetch } from "./apiClient";

export default function LtpResourcesPage({ onBack, canEdit }: { onBack: () => void; canEdit: boolean }) {
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const upload = async () => {
    if (!file || busy) return;
    setBusy(true); setError(""); setNotice("");
    try {
      const body = new FormData(); body.append("file", file);
      const response = await apiFetch("/api/ltp/resources/import", { method: "POST", body });
      const data = await response.json() as { imported?: number; error?: string };
      if (!response.ok) throw new Error(data.error ?? "Не удалось обновить справочник.");
      setNotice(`Справочник обновлён: загружено строк — ${(data.imported ?? 0).toLocaleString("ru-RU")}.`);
      setFile(null); if (input.current) input.current.value = "";
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Не удалось обновить справочник."); }
    finally { setBusy(false); }
  };

  return <section className="section-view ltp-resources-page">
    <div className="eyebrow"><span className="eyebrow-line" /> 1ЛТП</div>
    <div className="section-hero"><span className="section-hero-icon"><FileSpreadsheet size={22} /></span><div><h1>Справочник ресурсов и SNI</h1><p>Загрузка XLSX обновляет справочник, используемый журналом блокировок.</p></div><button type="button" className="text-button" onClick={onBack}><ArrowLeft size={15} /> Назад</button></div>
    <section className="panel ltp-blocks-form ltp-resources-form">
      <p className="ltp-resources-intro">В первой строке файла должны быть столбцы «Ресурс» и «SNI». При успешной загрузке текущие записи справочника заменяются данными файла.</p>
      <div className="field-label">Файл XLSX
        <div className="ltp-file-picker"><input ref={input} type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" onChange={(event) => setFile(event.target.files?.[0] ?? null)} /><button type="button" className="outline-button" onClick={() => input.current?.click()}>Выберите файл</button><span className="ltp-file-name">{file?.name ?? "Файл не выбран"}</span></div>
      </div>
      <button type="button" className="btn-primary" disabled={!canEdit || !file || busy} onClick={() => void upload()}><Upload size={15} />{busy ? "Обновляем…" : "Загрузить и заменить справочник"}</button>
      {!canEdit && <span className="ltp-blocks-hint">Для загрузки справочника нужны права оператора.</span>}
    </section>
    {error && <div className="assignment-error" role="alert">{error}</div>}
    {notice && <div className="portal-config-feedback portal-config-feedback-success" role="status">{notice}</div>}
  </section>;
}
