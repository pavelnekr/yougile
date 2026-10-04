import { useCallback, useEffect, useState } from "react";
import type { FixtureMode } from "./worstCase";

const MODES: FixtureMode[] = ["demo", "worst", "empty", "huge"];

// Выбор живёт в параметре адреса, поэтому переживает перезагрузку и его можно
// переслать. В продакшне параметр игнорируется: import.meta.env.DEV там false,
// переключатель не рисуется, набор данных выбрать нечем, а значит и модуль с
// фикстурами никогда не запрашивается.
function readMode(): FixtureMode {
  if (!import.meta.env.DEV) return "demo";
  const value = new URLSearchParams(window.location.search).get("data");
  return MODES.includes(value as FixtureMode) ? (value as FixtureMode) : "demo";
}

export function useFixtureMode(): [FixtureMode, (mode: FixtureMode) => void] {
  const [mode, setMode] = useState<FixtureMode>(readMode);

  useEffect(() => {
    const onPopState = () => setMode(readMode());
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  const choose = useCallback((next: FixtureMode) => {
    const url = new URL(window.location.href);
    if (next === "demo") url.searchParams.delete("data");
    else url.searchParams.set("data", next);
    window.history.replaceState(null, "", url);
    setMode(next);
  }, []);

  return [mode, choose];
}