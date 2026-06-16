// packages/plugin-poker/src/PokerPage.tsx
// 简单的主页面 alias：硬切换文档保留 "/poker" 的单一 alias；实际渲染
// 由 PokerLobby 完成。
import React from "react";
import { PokerLobby } from "./PokerLobby.js";

export function PokerPage(): React.ReactElement {
  return <PokerLobby />;
}
