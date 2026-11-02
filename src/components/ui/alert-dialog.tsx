import * as React from 'react'
import * as AlertDialogPrimitive from '@radix-ui/react-alert-dialog'

import { cn } from '@/lib/utils'
import { useT } from '@/lib/i18n'
import { Button } from './button'
import { modalVariants, overlayCls } from './modal'

/* "Are you sure?" as a real dialog rather than window.confirm: it can be
   styled, it says what will happen in the app's own voice, and — the part
   window.confirm cannot do — it names its action ("Delete guide") instead of
   an anonymous OK. Radix gives it the alertdialog role, focus on the safe
   action, and Escape/outside-click that both mean cancel. */
function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  cancelLabel,
  destructive = false,
  onConfirm,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: React.ReactNode
  description?: React.ReactNode
  confirmLabel?: string
  cancelLabel?: string
  destructive?: boolean
  onConfirm: () => void
}) {
  const t = useT()
  return (
    <AlertDialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <AlertDialogPrimitive.Portal>
        <AlertDialogPrimitive.Overlay className={cn(overlayCls, 'z-[80]')} />
        <AlertDialogPrimitive.Content
          data-slot="confirm-dialog"
          className={cn(modalVariants({ size: 'sm' }), 'z-[80]')}
        >
          <AlertDialogPrimitive.Title className="text-lead font-medium leading-5">{title}</AlertDialogPrimitive.Title>
          {description ? (
            <AlertDialogPrimitive.Description className="mt-1 text-copy leading-[22px] text-ink-soft">
              {description}
            </AlertDialogPrimitive.Description>
          ) : null}
          <div className="mt-6 flex flex-wrap justify-end gap-2.5 [&>*]:max-xs:flex-1 [&>*]:max-xs:justify-center">
            <AlertDialogPrimitive.Cancel asChild>
              <Button variant="ghost">{cancelLabel ?? t('common.cancel')}</Button>
            </AlertDialogPrimitive.Cancel>
            <AlertDialogPrimitive.Action asChild>
              <Button variant={destructive ? 'danger-solid' : 'primary'} onClick={onConfirm}>
                {confirmLabel ?? t('ui.confirm')}
              </Button>
            </AlertDialogPrimitive.Action>
          </div>
        </AlertDialogPrimitive.Content>
      </AlertDialogPrimitive.Portal>
    </AlertDialogPrimitive.Root>
  )
}

export { ConfirmDialog }
