// packages/ui/src/Modal.tsx
// 原生模态框；关闭由调用方确认，保留忙碌态限制和未关闭的草稿。

import { useId, useLayoutEffect, useRef, type ReactNode } from "react";

export interface ModalProps {
  open: boolean;
  title?: string;
  onClose?: () => void;
  children: ReactNode;
  footer?: ReactNode;
  closeButtonLabel?: string;
  "data-testid"?: string;
}

export function Modal({ open, title, onClose, children, footer, closeButtonLabel, "data-testid": testId }: ModalProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const pressedOutside = useRef(false);
  useLayoutEffect(() => {
    const element = dialog.current;
    if (!open || !element) return;
    // Prefer an explicit autofocus target; otherwise focus the safe footer action.
    const safeAction = element.querySelector<HTMLElement>("[autofocus]")
      ?? element.querySelector<HTMLElement>(".ui-modal__footer button:not(:disabled)");
    const hadAutofocus = safeAction?.hasAttribute("autofocus");
    safeAction?.setAttribute("autofocus", "");
    element.showModal();
    if (!hadAutofocus) safeAction?.removeAttribute("autofocus");
    return () => { element.close(); };
  }, [open]);
  const outside = (event: { clientX: number; clientY: number }) => {
    const bounds = panel.current?.getBoundingClientRect();
    return !!bounds && (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom);
  };

  return (
    <dialog ref={dialog} className="ui-modal" aria-labelledby={title ? titleId : undefined} aria-label={title ? undefined : closeButtonLabel} data-testid={testId}
      onCancel={event => { event.preventDefault(); onClose?.(); }}
      onPointerDown={event => { pressedOutside.current = outside(event); }}
      onPointerUp={event => { if (pressedOutside.current && outside(event)) onClose?.(); pressedOutside.current = false; }}
      onPointerCancel={() => { pressedOutside.current = false; }}>
      {open ? <div ref={panel} className="ui-modal__panel">
        {closeButtonLabel && onClose ? <button type="button" className="ui-modal__close" onClick={onClose} aria-label={closeButtonLabel}>×</button> : null}
        {title ? <h2 id={titleId} className="ui-modal__header">{title}</h2> : null}
        <div className="ui-modal__body">{children}</div>
        {footer ? <footer className="ui-modal__footer">{footer}</footer> : null}
      </div> : null}
    </dialog>
  );
}
