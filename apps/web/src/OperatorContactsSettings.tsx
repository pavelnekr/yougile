import { useEffect, useState } from "react";
import { CheckCircle2, Eye, FileSpreadsheet, LoaderCircle, Trash2, Upload } from "lucide-react";
import { apiFetch } from "./apiClient";
import ConfirmDialog from "./ConfirmDialog";

type OperatorContactRow = {
  region: string;
  site: string;
  siteNumber: string | null;
  operator: string;
  contacts: string;
  emails: string[];
  invalidEmails: string[];
};

type DirectoryStatus = {
  configured: boolean;
  rowCount: number;
  importedAt: string | null;
  importedBy: string | null;
  canManage: boolean;
};

function messageOf(error: unknown) {
  return error instanceof Error ? error.message : "Не удалось выполнить запрос.";
}

export default function OperatorContactsSettings() {
  const [status, setStatus] = useState<DirectoryStatus | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [filePassword, setFilePassword] = useState("");
  const [rows, setRows] = useState<OperatorContactRow[] | null>(null);
  const [viewImportedAt, setViewImportedAt] = useState("");
  const [busy, setBusy] = useState(false);
  const [clearOpen, setClearOpen] = useState(false);
  const [loadingStatus, setLoadingStatus] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const refreshStatus = async (signal?: AbortSignal) => {
    const response = await apiFetch("/api/coordination/operator-contacts/status", { signal });
    const data = await response.json() as DirectoryStatus & { error?: string };
    if (!response.ok) throw new Error(data.error ?? "Не удалось загрузить состояние справочника.");
    setStatus(data);
  };

  useEffect(() => {
    const controller = new AbortController();
    void refreshStatus(controller.signal)
      .catch((reason: unknown) => { if (!controller.signal.aborted) setError(messageOf(reason)); })
      .finally(() => { if (!controller.signal.aborted) setLoadingStatus(false); });
    return () => controller.abort();
  }, []);

  const upload = async () => {
    if (!file || !filePassword || busy) return;
    setBusy(true); setError(""); setNotice(""); setRows(null);
    try {
      const body = new FormData();
      body.append("file", file);
      body.append("password", filePassword);
      const response = await apiFetch("/api/coordination/operator-contacts/upload", { method: "POST", body });
      const data = await response.json() as { rowCount?: number; importedAt?: string; error?: string; message?: string };
      if (!response.ok || !data.importedAt) throw new Error(data.error ?? "Не удалось загрузить справочник.");
      await refreshStatus();
      setNotice(data.message ?? `Справочник обновлён: ${data.rowCount ?? 0} строк.`);
      setFile(null);
      const input = document.getElementById("operator-contacts-file") as HTMLInputElement | null;
      if (input) input.value = "";
    } catch (reason) { setError(messageOf(reason)); }
    finally { setFilePassword(""); setBusy(false); }
  };

  const reveal = async () => {
    if (busy) return;
    setBusy(true); setError(""); setNotice(""); setRows(null);
    try {
      const response = await apiFetch("/api/coordination/operator-contacts/view", { method: "POST" });
      const data = await response.json() as { rows?: OperatorContactRow[]; importedAt?: string; error?: string };
      if (!response.ok || !data.rows) throw new Error(data.error ?? "Не удалось открыть справочник.");
      setRows(data.rows);
      setViewImportedAt(data.importedAt ?? "");
      setNotice("Справочник расшифрован для просмотра.");
    } catch (reason) { setError(messageOf(reason)); }
    finally { setBusy(false); }
  };

  const clearDirectory = async () => {
    if (busy) return;
    setBusy(true); setError(""); setNotice(""); setRows(null);
    try {
      const response = await apiFetch("/api/coordination/operator-contacts", { method: "DELETE" });
      const data = await response.json() as { deleted?: boolean; error?: string; message?: string };
      if (!response.ok) throw new Error(data.error ?? "Не удалось очистить справочник.");
      setStatus({ configured: false, rowCount: 0, importedAt: null, importedBy: null, canManage: true });
      setFile(null); setFilePassword(""); setClearOpen(false);
      const input = document.getElementById("operator-contacts-file") as HTMLInputElement | null;
      if (input) input.value = "";
      setNotice(data.message ?? "Справочник удалён.");
    } catch (reason) { setError(messageOf(reason)); setClearOpen(false); }
    finally { setBusy(false); }
  };

  return <>
    <section className="coordination-settings-subsection">
      <h2><FileSpreadsheet size={16} /> Справочник email операторов</h2>
      <p>Загрузите актуальный XLSX и введите пароль от него. Ожидаются колонки «Округ», «Площадка», «Оператор» и «Контакты». Номер площадки берётся из начала поля «Площадка».</p>
      {status?.canManage && <>
        <label className="operator-contacts-file-label" htmlFor="operator-contacts-file">Файл Excel (.xlsx)
          <input id="operator-contacts-file" type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" onChange={(event) => setFile(event.target.files?.[0] ?? null)} />
        </label>
        <label>Пароль от файла
          <input type="password" autoComplete="off" value={filePassword} maxLength={255} onChange={(event) => setFilePassword(event.target.value)} />
        </label>
        <div className="operator-contacts-actions">
          <button type="button" className="btn-primary" disabled={!file || !filePassword || busy} onClick={() => void upload()}>
            {busy ? <LoaderCircle size={15} className="template-spinner" /> : <Upload size={15} />}{busy ? "Обрабатываем…" : "Загрузить и обновить справочник"}
          </button>
          {status.configured && <button type="button" className="outline-button operator-contacts-clear" disabled={busy} onClick={() => setClearOpen(true)}><Trash2 size={15} /> Очистить базу</button>}
        </div>
      </>}
      {loadingStatus && <p className="operator-contacts-meta">Загружаем состояние справочника…</p>}
      {!loadingStatus && status?.configured && <p className="operator-contacts-meta">В базе: {status.rowCount} строк · обновлён {new Date(status.importedAt!).toLocaleString("ru-RU")}{status.importedBy ? ` · ${status.importedBy}` : ""}</p>}
      {!loadingStatus && status && !status.configured && <p className="operator-contacts-meta">Справочник ещё не загружен.</p>}
    </section>
    <section className="coordination-settings-subsection">
      <h2><Eye size={16} /> Просмотр данных</h2>
      {status?.canManage && <>
        <p>Откройте загруженный справочник, чтобы посмотреть данные и проверить адреса.</p>
        <button type="button" className="outline-button" disabled={!status?.configured || busy} onClick={() => void reveal()}>
          {busy ? <LoaderCircle size={15} className="template-spinner" /> : <Eye size={15} />}{busy ? "Проверяем…" : "Расшифровать и показать"}
        </button>
      </>}
      {rows && <div className="operator-contacts-table-wrap">
        <p className="operator-contacts-meta">Расшифровано: {rows.length} строк · {new Date(viewImportedAt).toLocaleString("ru-RU")}</p>
        <table className="operator-contacts-table">
          <thead><tr><th>Номер</th><th>Округ</th><th>Площадка</th><th>Оператор</th><th>Контакты</th><th>Проверка</th></tr></thead>
          <tbody>{rows.map((row, index) => <tr key={`${row.siteNumber ?? "missing"}-${index}`}>
            <td>{row.siteNumber ?? "—"}</td><td>{row.region || "—"}</td><td>{row.site || "—"}</td><td>{row.operator || "—"}</td><td>{row.contacts || "—"}</td>
            <td>{row.invalidEmails.length ? `Некорректно: ${row.invalidEmails.join(", ")}` : row.emails.length ? `${row.emails.length} адрес(а)` : "Нет адресов"}</td>
          </tr>)}</tbody>
        </table>
      </div>}
    </section>
    {error && <div className="portal-config-feedback portal-config-feedback-error" role="alert">{error}</div>}
    {notice && <div className="portal-config-feedback portal-config-feedback-success" role="status"><CheckCircle2 size={15} />{notice}</div>}
    {clearOpen && <ConfirmDialog
      title="Очистить справочник?"
      confirmLabel={busy ? "Очищаем…" : "Удалить справочник"}
      onCancel={() => { if (!busy) setClearOpen(false); }}
      onConfirm={() => void clearDirectory()}
    >
      Зашифрованный справочник email операторов будет удалён из базы. Для восстановления потребуется загрузить файл заново.
    </ConfirmDialog>}
  </>;
}
