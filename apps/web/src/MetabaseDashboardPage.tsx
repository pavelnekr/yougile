import { createElement, useEffect, useState } from "react";
import { ArrowLeft, BarChart3 } from "lucide-react";
import { apiFetch } from "./apiClient.js";

declare global {
  interface Window {
    metabaseConfig?: {
      theme: { preset: "light" };
      isGuest: true;
      instanceUrl: string;
    };
  }
}

let embedScriptPromise: Promise<void> | null = null;

function loadMetabaseEmbed() {
  if (window.customElements.get("metabase-dashboard")) return Promise.resolve();
  if (!embedScriptPromise) {
    window.metabaseConfig = { theme: { preset: "light" }, isGuest: true, instanceUrl: "https://metabase.dcoa.ru" };
    embedScriptPromise = new Promise<void>((resolve, reject) => {
      const script = document.createElement("script");
      script.src = "https://metabase.dcoa.ru/app/embed.js";
      script.defer = true;
      script.onload = () => resolve();
      script.onerror = () => {
        embedScriptPromise = null;
        reject(new Error("Не удалось загрузить компонент Metabase."));
      };
      document.head.append(script);
    });
  }
  return embedScriptPromise;
}

export default function MetabaseDashboardPage({ onBack }: { onBack: () => void }) {
  const [token, setToken] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    const refreshToken = async () => {
      try {
        const response = await apiFetch("/api/ltp/metabase-token");
        const data = await response.json() as { token?: string; error?: string };
        if (!response.ok || !data.token) throw new Error(data.error ?? "Не удалось получить токен дашборда.");
        await loadMetabaseEmbed();
        if (active) { setToken(data.token); setError(""); }
      } catch (cause) {
        if (active) setError(cause instanceof Error ? cause.message : "Не удалось открыть дашборд.");
      }
    };
    void refreshToken();
    const interval = window.setInterval(() => void refreshToken(), 8 * 60 * 1000);
    return () => { active = false; window.clearInterval(interval); };
  }, []);

  return <section className="section-view ltp-metabase-page">
    <div className="eyebrow"><span className="eyebrow-line" /> 1ЛТП</div>
    <div className="section-hero"><span className="section-hero-icon"><BarChart3 size={22} /></span><div><h1>Дашборды Metabase</h1><p>Интерактивная аналитика 1ЛТП.</p></div><button type="button" className="text-button" onClick={onBack}><ArrowLeft size={15} /> Назад</button></div>
    {error ? <div className="assignment-error" role="alert">{error}</div> : token ? <div className="ltp-metabase-frame">{createElement("metabase-dashboard", { token, "with-title": "true", "with-downloads": "true" })}</div> : <div className="panel ltp-metabase-loading">Загружаем дашборд…</div>}
  </section>;
}
