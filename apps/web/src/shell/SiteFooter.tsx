// apps/web/src/shell/SiteFooter.tsx
// 站点级 footer：
//   - onboarding 与已解锁控制面板共用同一份联系信息。
//   - 仓库地址与联系邮箱属于站点元信息，不应散落到多个页面各自维护。
// 设计缘由：
//   - 这类信息变更频率低，但影响范围跨两套 shell；
//   - 提取成共享组件后，后续只需改一个地方。

import { AppLink } from "@keymaster/runtime";

export interface SiteFooterProps {
  variant?: "onboarding" | "app";
}

export function SiteFooter({ variant = "app" }: SiteFooterProps) {
  // Vite replaces these constants in production builds. Unit tests import the
  // component directly, so keep the footer renderable when that replacement is
  // intentionally absent.
  const gitBranch = typeof __KEYMASTER_GIT_BRANCH__ === "string" ? __KEYMASTER_GIT_BRANCH__ : "unknown";
  const gitRevision = typeof __KEYMASTER_GIT_REVISION__ === "string" ? __KEYMASTER_GIT_REVISION__ : "unknown";
  const gitCommitUrl = typeof __KEYMASTER_GIT_COMMIT_URL__ === "string" ? __KEYMASTER_GIT_COMMIT_URL__ : "";
  return (
    <footer className={`site-footer site-footer--${variant}`}>
      <div className="site-footer__content">
        <a
          className="site-footer__link"
          href="https://github.com/bsv8/keymaster.cc"
          target="_blank"
          rel="noreferrer"
        >
          bsv8/keymaster.cc
        </a>
        <span className="site-footer__separator" aria-hidden="true">
          /
        </span>
        <a className="site-footer__link" href="mailto:spycat55@keymaster.cc">
          spycat55@keymaster.cc
        </a>
        <span className="site-footer__separator" aria-hidden="true">
          /
        </span>
        <span>git {gitBranch}</span>
        <span className="site-footer__separator" aria-hidden="true">
          /
        </span>
        {gitCommitUrl ? (
          <AppLink
            className="site-footer__link"
            to={gitCommitUrl}
            target="_blank"
            rel="noreferrer"
            aria-label={`Open commit ${gitRevision} on GitHub`}
          >
            {gitRevision}
          </AppLink>
        ) : (
          <span>{gitRevision}</span>
        )}
      </div>
    </footer>
  );
}
