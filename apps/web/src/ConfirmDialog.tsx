import { AlertTriangle } from "lucide-react";
import type { ReactNode } from "react";
import Modal from "./Modal";

type ConfirmDialogProps = {
  title: string;
  children: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
};

/**
 * Окно подтверждения вместо `window.confirm`: та же логика, но в стиле портала
 * и с теми же клавишами, что у остальных окон — Escape отменяет.
 */
export default function ConfirmDialog({
  title,
  children,
  confirmLabel,
  cancelLabel = "Отмена",
  onConfirm,
  onCancel
}: ConfirmDialogProps) {
  return (
    <Modal labelledBy="confirm-dialog-title" onDismiss={onCancel}>
      <div className="dialog-heading">
        <span className="dialog-icon"><AlertTriangle size={17} /></span>
        <div><h2 id="confirm-dialog-title">{title}</h2></div>
      </div>
      <div className="dialog-body">{children}</div>
      <div className="dialog-actions">
        <button className="text-button" onClick={onCancel}>{cancelLabel}</button>
        <button className="btn-primary" onClick={onConfirm}>{confirmLabel}</button>
      </div>
    </Modal>
  );
}