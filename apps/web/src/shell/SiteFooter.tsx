// apps/web/src/shell/SiteFooter.tsx
// 站点级 footer：
//   - onboarding 与已解锁控制面板共用同一份联系信息。
//   - 仓库地址与联系邮箱属于站点元信息，不应散落到多个页面各自维护。
// 设计缘由：
//   - 这类信息变更频率低，但影响范围跨两套 shell；
//   - 提取成共享组件后，后续只需改一个地方。

export interface SiteFooterProps {
  variant?: "onboarding" | "app";
}

export function SiteFooter({ variant = "app" }: SiteFooterProps) {
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
      </div>
    </footer>
  );
}
