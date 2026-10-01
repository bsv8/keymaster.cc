// 首次初始化的入口页（单 Key 本地存储，docs/存储.md）。
//
// 本地钱包没有存储类型选择、没有桶配置、没有"连接已有远程空间"。
// 未初始化时唯一的两个路径就是创建钱包 Key 与导入钱包 Key，而这两个
// 入口连同它们的表单、导入向导与错误处理都已经收敛到 LockedShell。
//
// 因此本组件只保留旧调用点（App 启动门禁）需要的名字，实际渲染
// LockedShell；不复制任何一份初始化 UI，避免两条路径日后漂移。

import { LockedShell } from "./LockedShell.js";

export function InitialSetupPage() {
  return <LockedShell />;
}
