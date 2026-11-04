'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';

type Text = { title: string; description: string; confirmLabel: string };

/**
 * Asks before an action, in place of the browser's confirm box (#267), which can't be
 * translated or styled and can't say what the action will do. Confirming closes it and runs
 * `onConfirm`; Cancel, Escape and closing it any other way run nothing.
 *
 * Callers usually open it for one row (`open={removeFor !== null}`) and clear the row when it
 * closes, so it keeps the text it was opened with while it animates closed.
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  cancelLabel,
  destructive = true,
  onConfirm,
}: Text & {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  cancelLabel?: string;
  destructive?: boolean;
  onConfirm: () => void;
}) {
  const tc = useTranslations('common');
  const [shown, setShown] = useState<Text>({ title, description, confirmLabel });
  if (open && (shown.title !== title || shown.description !== description || shown.confirmLabel !== confirmLabel)) {
    setShown({ title, description, confirmLabel });
  }

  return (
    <AlertDialog open={open} onOpenChange={(next) => onOpenChange(next)}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{shown.title}</AlertDialogTitle>
          <AlertDialogDescription>{shown.description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{cancelLabel ?? tc('actions.cancel')}</AlertDialogCancel>
          <AlertDialogAction
            variant={destructive ? 'destructive' : 'default'}
            onClick={() => {
              // A second click while it animates closed doesn't run the action again
              if (!open) return;
              onOpenChange(false);
              onConfirm();
            }}
          >
            {shown.confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
