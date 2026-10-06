import { useMemo, useState } from "react";
import { Check, Copy } from "lucide-react";
import { copyText } from "./clipboard";

/**
 * Блок «Диагностика для поддержки»: копируемый JSON с деталями ошибки.
 *
 * Показывается над панелью операции, когда что-то пошло не так. Нажатие
 * «Скопировать» кладёт в буфер весь JSON — оператор вставляет его в сообщение
 * разработчику, не пересказывая ошибку своими словами. Содержимое видно и на
 * месте, под summary, разворачивается и сворачивается без таймеров.
 */
export default function ErrorDiagnostics({ payload }: { payload: Record<string, unknown> }) {
  const [copied, setCopied] = useState(false);
  const text = useMemo(() => JSON.stringify(payload, null, 2), [payload]);

  const copy = () => {
    void copyText(text).then((ok) => {
      if (!ok) return;
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  return (
    <div className="diagnostics-block">
      <div className="diagnostics-head">
        <span>Диагностика для поддержки</span>
        <button type="button" className="text-button diagnostics-copy" onClick={copy} disabled={copied}>
          {copied ? <Check size={13} /> : <Copy size={13} />} {copied ? "Скопировано" : "Скопировать"}
        </button>
      </div>
      <details className="diagnostics-details">
        <summary>Показать данные для анализа</summary>
        <pre>{text}</pre>
      </details>
    </div>
  );
}