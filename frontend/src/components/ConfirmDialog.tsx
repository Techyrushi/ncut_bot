import { useEffect, useId, useRef } from 'react';

type ConfirmDialogProps = {
  title: string;
  message: string;
  confirmLabel: string;
  pendingLabel?: string;
  isPending?: boolean;
  error?: string;
  onConfirm: () => void;
  onCancel: () => void;
};

export function ConfirmDialog({
  title,
  message,
  confirmLabel,
  pendingLabel = 'Working…',
  isPending = false,
  error,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const titleId = useId();
  const messageId = useId();
  const cancelButton = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    cancelButton.current?.focus();
  }, []);

  useEffect(() => {
    if (isPending) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onCancel();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isPending, onCancel]);

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !isPending) onCancel();
      }}
    >
      <section
        className="modal-card confirmation-modal"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={messageId}
      >
        <div className="confirmation-icon" aria-hidden="true">!</div>
        <h2 id={titleId}>{title}</h2>
        <p id={messageId}>{message}</p>
        {error && <p className="form-error" role="alert">{error}</p>}
        <div className="modal-actions">
          <button
            ref={cancelButton}
            type="button"
            className="secondary-button"
            onClick={onCancel}
            disabled={isPending}
          >
            Cancel
          </button>
          <button
            type="button"
            className="confirm-danger-button"
            onClick={onConfirm}
            disabled={isPending}
          >
            {isPending ? pendingLabel : confirmLabel}
          </button>
        </div>
      </section>
    </div>
  );
}
