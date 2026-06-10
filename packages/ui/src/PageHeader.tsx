// packages/ui/src/PageHeader.tsx
// 页面顶部标题 + 描述 + 操作位。
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

export interface PageHeaderProps {
  title: RenderableText;
  description?: RenderableText;
  actions?: ReactNode;
}

export function PageHeader({ title, description, actions }: PageHeaderProps) {
  return (
    <header className="ui-page-header">
      <div>
        <h1 className="ui-page-header__title">{toText(title)}</h1>
        {description ? <p className="ui-page-header__description">{toText(description)}</p> : null}
      </div>
      {actions ? <div className="ui-page-header__actions">{actions}</div> : null}
    </header>
  );
}
