import { AlertTriangle } from "lucide-react";
import Modal from "./Modal";
import { pluralRu, siteForms } from "./plural";

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
    <Modal labelledBy="bulk-warning-title" onDismiss={onCancel}>
      <div className="dialog-heading">
        <span className="dialog-icon"><AlertTriangle size={17} /></span>
        <div>
          <h2 id="bulk-warning-title">Большая операция</h2>
          <p title={fileName}>{fileName}</p>
        </div>
      </div>
      <div className="dialog-body">
        В файле <strong>{siteCount.toLocaleString("ru-RU")}</strong> {pluralRu(siteCount, siteForms)} для обработки.
        {skippedCount > 0 && <> Пропустим строк без совпадений в YouGile: <strong>{skippedCount.toLocaleString("ru-RU")}</strong>.</>}
        {" "}Площадки обрабатываются последовательно, поэтому предпросмотр и сама операция займут заметное время.
        {" "}Убедитесь, что в файле нет лишних строк, и продолжайте частями, если нужно увидеть результат быстрее.
      </div>
      <div className="dialog-actions">
        <button className="text-button" onClick={onCancel}>Отмена</button>
        <button className="btn-primary" onClick={onConfirm}>Продолжить</button>
      </div>
    </Modal>
  );
}