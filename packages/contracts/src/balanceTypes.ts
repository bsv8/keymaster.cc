// packages/contracts/src/balanceTypes.ts
// 跨插件共享的 P2PKH 余额类型。
// 这些类型只表达“由 UTXO 快照派生出的只读结果”，不保存任何余额真值。

/** 余额明细；所有金额单位都是 sat（聪）。 */
export interface P2pkhBalanceBreakdown {
  /** 已确认且仍可计入余额的输出总额。 */
  confirmed: number;
  /** 未确认但尚未被内存池花费的输出总额。 */
  unconfirmed: number;
  /** 当前 UTXO 快照中可花费的金额；只排除内存池已花费输出。 */
  spendable: number;
}

/** P2PKH 余额；快照不可用时 available=false，不能把 total 当作 0 展示。 */
export interface P2pkhBalance {
  /** 可花费余额，单位 sat；available=false 时只是占位值，没有业务意义。 */
  total: number;
  /** UTXO 快照是否可信；false 表示未知，不表示余额为 0。 */
  available?: boolean;
  /** 可选余额明细；与 total 使用同一份 UTXO 快照计算。 */
  breakdown?: P2pkhBalanceBreakdown;
}
