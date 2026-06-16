// packages/plugin-poker/src/pokerMessages.ts
// Poker 业务事件常量集合。
//
// 设计缘由：硬切换文档要求 "plugin-poker 与 poker-proxy 的内部浏览器协议
// 必须有版本号"；本文件集中维护 messageBus 事件名 + proxy 帧类型，
// 与 contracts/poker.ts 的常量保持 1:1。

export const POKER_EVENT = {
  /** 连接状态变更，payload: { status: PokerConnectionStatus } */
  StatusChange: "poker.status",
  /** 一条新 presence；payload: PokerPresence */
  Presence: "poker.presence",
  /** 桌列表整体刷新；payload: PokerTable[] */
  Tables: "poker.tables",
  /** 收到 raw tx 事件；payload: PokerTxEvent */
  Tx: "poker.tx",
  /** 收到 frame 事件；payload: PokerFrameDeliver */
  Frame: "poker.frame",
  /** settings 更新 */
  SettingsChanged: "poker.settingsChanged"
} as const;

export type PokerEventName = (typeof POKER_EVENT)[keyof typeof POKER_EVENT];
