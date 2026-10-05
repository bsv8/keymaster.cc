// apps/web/src/shell/BrandIcon.tsx
// 品牌图标：统一承载站点 favicon / 顶栏 / onboarding 头部使用的同一张视觉稿。
// 设计缘由：
//   - 当前用户已确认使用盾牌钥匙孔稿作为品牌标记；
//   - 先收敛成一个组件，避免 Topbar / OnboardingHeader 后续各自分叉样式；
//   - 页面内展示不直接裸露原始大图，而是放进固定尺寸容器里，便于控制裁切、
//     圆角和深浅主题下的一致观感。

export interface BrandIconProps {
  className?: string;
}

export function BrandIcon({ className = "" }: BrandIconProps) {
  const classes = ["brand-icon", className].filter(Boolean).join(" ");
  return <span className={classes} aria-hidden="true" />;
}
