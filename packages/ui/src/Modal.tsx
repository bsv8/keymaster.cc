// packages/ui/src/Modal.tsx
// 简易模态框：使用 fixed 定位 + 半透明遮罩。

import { useEffect, type ReactNode } from "react";

export interface ModalProps {
  open: boolean;
  title?: string;
  onClose?: () => void;
  children: ReactNode;
  footer?: ReactNode;
}

export function Modal({ open, title, onClose, children, footer }: ModalProps) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose?.();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className="ui-modal" role="dialog" aria-modal="true">
      <div className="ui-modal__backdrop" onClick={onClose} />
      <div className="ui-modal__panel">
        {title ? <header className="ui-modal__header">{title}</header> : null}
        <div className="ui-modal__body">{children}</div>
        {footer ? <footer className="ui-modal__footer">{footer}</footer> : null}
      </div>
    </div>
  );
}
