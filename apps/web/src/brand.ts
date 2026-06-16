// apps/web/src/brand.ts
// 品牌文案集中定义。
// 设计缘由：
//   - `KeyMaster` 仅用于页签标题、logo、商标位等品牌展示；
//   - 正文文案仍可按语义继续使用 `Keymaster`，避免把品牌字样误扩散到普通句子里。

/** 商标/标题位使用的统一品牌写法。 */
export const BRAND_WORDMARK = "KeyMaster";
