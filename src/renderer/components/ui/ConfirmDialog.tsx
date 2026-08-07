import { useState, type ReactNode } from 'react';
import { AlertTriangle } from 'lucide-react';
import { cn } from '../../lib/utils';
import { Dialog } from './Dialog';
import { Button } from './Button';

export interface ConfirmDialogProps {
  open: boolean;
  title: ReactNode;
  /** One sentence saying what will happen. Plain language, no jargon. */
  description?: ReactNode;
  /** Extra detail — the exact path, the row count, the raw command. */
  children?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  /** `danger` turns the confirm button red and shows a warning icon. */
  tone?: 'default' | 'danger';
  /** May be async; the button shows a spinner until it settles. */
  onConfirm: () => void | Promise<void>;
  onCancel: () => void;
}

/**
 * Yes/no gate for anything irreversible. Confirm is never the default focus
 * target — Dialog focuses the first control, which is Cancel.
 */
export function ConfirmDialog({
  open,
  title,
  description,
  children,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  tone = 'default',
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const [pending, setPending] = useState(false);

  const handleConfirm = async () => {
    try {
      setPending(true);
      await onConfirm();
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={pending ? () => {} : onCancel}
      size="sm"
      hideCloseButton
      disableOverlayClose={pending}
      disableEscapeClose={pending}
      title={
        <span className="flex items-center gap-2">
          {tone === 'danger' ? (
            <AlertTriangle
              size={15}
              aria-hidden="true"
              className="shrink-0 text-rose-600 dark:text-rose-400"
            />
          ) : null}
          {title}
        </span>
      }
      description={description}
      footer={
        <>
          <Button variant="ghost" onClick={onCancel} disabled={pending}>
            {cancelLabel}
          </Button>
          <Button
            variant={tone === 'danger' ? 'destructive' : 'primary'}
            onClick={handleConfirm}
            loading={pending}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      {children ? (
        <div className={cn('text-[13px]')}>{children}</div>
      ) : null}
    </Dialog>
  );
}

export default ConfirmDialog;
