import { CheckCircle2, Clock3, Minus, XCircle } from "lucide-react";

export type OperationSiteItem = {
  siteId: string;
  status: string;
  errorMessage: string | null;
};

// Статусы площадки внутри операции. Класс вешается на строку, цвет статуса
// задаётся в styles.css как `operation-site-<status> .operation-site-status`.
const STATUS_META: Record<string, { label: string; icon: typeof CheckCircle2; className: string }> = {
  SUCCEEDED: { label: "Готово", icon: CheckCircle2, className: "operation-site-succeeded" },
  FAILED: { label: "Ошибка", icon: XCircle, className: "operation-site-failed" },
  PENDING: { label: "В очереди", icon: Clock3, className: "operation-site-pending" },
  SKIPPED: { label: "Пропущена", icon: Minus, className: "operation-site-skipped" }
};

/**
 * Таблица площадок операции: номер, адрес/задача и статус каждой строки —
 * что уже обработано, а что ещё в очереди. Прогресс-бар остаётся один,
 * таблица дополняет его поштучным состоянием.
 */
export default function OperationSites({
  items,
  labelColumn,
  labels
}: {
  items: OperationSiteItem[];
  labelColumn: string;
  labels?: Record<string, string | null>;
}) {
  return (
    <div className="operation-sites">
      <div className="operation-sites-head">
        <span>Площадка</span>
        <span>{labelColumn}</span>
        <span>Статус</span>
      </div>
      {items.map((item) => {
        const meta = STATUS_META[item.status];
        const Icon = meta?.icon ?? Minus;
        const label = labels?.[item.siteId];
        return (
          <div className={`operation-site-row ${meta?.className ?? ""}`} key={item.siteId}>
            <span className="site-number">{item.siteId}</span>
            <span className="operation-site-label" title={label ?? ""}>{label || "—"}</span>
            <span className="operation-site-status" title={item.errorMessage ?? undefined}>
              <Icon size={13} /> {meta?.label ?? item.status}
            </span>
          </div>
        );
      })}
    </div>
  );
}