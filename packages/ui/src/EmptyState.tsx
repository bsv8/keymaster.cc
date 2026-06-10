// packages/ui/src/EmptyState.tsx
// 空状态。
//
// 硬切换 003：title / description 接受 I18nText | string。

import type { ReactNode } from "react";
import type { I18nText } from "@keymaster/contracts";

type RenderableText = string | I18nText;

function toText(input: RenderableText | undefined): string {
  if (input == null) return "";
  if (typeof input === "string") return input;
  return input.fallback;
}

export interface EmptyStateProps {
  title: RenderableText;
  description?: RenderableText;
  action?: ReactNode;
  icon?: ReactNode;
}

export function EmptyState({ title, description, action, icon }: EmptyStateProps) {
  return (
    <div className="ui-empty-state">
      {icon ? <div className="ui-empty-state__icon">{icon}</div> : null}
      <h3 className="ui-empty-state__title">{toText(title)}</h3>
      {description ? <p className="ui-empty-state__description">{toText(description)}</p> : null}
      {action ? <div className="ui-empty-state__action">{action}</div> : null}
    </div>
  );
}
