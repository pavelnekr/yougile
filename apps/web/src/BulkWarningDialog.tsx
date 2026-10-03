import { AlertTriangle } from "lucide-react";

// Порог, после которого операция считается большой и требует подтверждения.
// Мягкое предупреждение: в API стоит аварийный предохранитель на 2000 площадок,
// до него пользователя доводим заранее.
export const largeSelectionThreshold = 100;

type BulkWarningDialogProps = {
  fileName: string;
  siteCount: number;
  skippedCount?: number;
  onConfirm: () => void;
  onCancel: () => void;
};

/**
 * Небольшое модальное окно, которое спрашивает подтверждение перед операцией
 * с большим числом площадок: предпросмотр и очередь обрабатывают их строго
 * последовательно, поэтому запуск занимает заметное время.
 */
export default function BulkWarningDialog({
  fileName,
  siteCount,
  skippedCount = 0,
  onConfirm,
  onCancel
}: BulkWarningDialogProps) {
  return (
    <div className="bulk-warning-overlay" role="dialog" aria-modal="true" aria-labelledby="bulk-warning-title">
      <div className="bulk-warning-dialog">
        <div className="bulk-warning-heading">
          <span className="bulk-warning-icon"><AlertTriangle size={17} /></span>
          <div>
            <h2 id="bulk-warning-title">Большая операция</h2>
            <p title={fileName}>{fileName}</p>
          </div>
        </div>
        <div className="bulk-warning-body">
          В файле найдено <strong>{siteCount.toLocaleString("ru-RU")}</strong> площадок для обработки.
          {skippedCount > 0 && <> Строки без совпадений в YouGile ({skippedCount.toLocaleString("ru-RU")}) будут пропущены.</>}
          {" "}Площадки обрабатываются последовательно, поэтому предпросмотр и сама операция займут заметное время.
          {" "}Убедитесь, что в файле нет лишних строк, и продолжайте частями, если нужно увидеть результат быстрее.
        </div>
        <div className="bulk-warning-actions">
          <button className="text-button" onClick={onCancel}>Отмена</button>
          <button className="btn-primary" onClick={onConfirm}>Продолжить</button>
        </div>
      </div>
    </div>
  );
}