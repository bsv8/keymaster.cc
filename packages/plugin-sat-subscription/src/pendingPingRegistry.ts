// Coordinator 的 Pending Ping 有界注册表。
//
// 这个小模块把“登记”和“消费 Pong”做成同步操作。调用方必须在网络
// Publish 之前 register；因此即使 Pong 早于 Publish Promise settle，也不会
// 因为 Promise 的时序而丢失。owner/session 的额外校验由调用方传入 predicate。

export interface PendingPingValue {
  messageId: string;
  expiresAtMs: number;
}

export class PendingPingRegistry<T extends PendingPingValue> {
  private readonly values = new Map<string, T>();

  constructor(
    private readonly maxSize: number,
    private readonly now: () => number = Date.now
  ) {
    if (!Number.isSafeInteger(maxSize) || maxSize < 1) throw new Error("Pending Ping maxSize is invalid");
  }

  get size(): number {
    return this.values.size;
  }

  /** 登记一个 pending；超出容量时淘汰最早的记录。 */
  set(value: T): void {
    this.prune();
    while (this.values.size >= this.maxSize) {
      const oldest = this.values.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.values.delete(oldest);
    }
    this.values.set(value.messageId, value);
  }

  /** 读取但不消费；用于诊断或校验前的快照。 */
  get(messageId: string): T | undefined {
    this.prune();
    return this.values.get(messageId);
  }

  /** 只在关系/owner/session 校验通过时消费 Pong。 */
  take(messageId: string, predicate?: (value: T) => boolean): T | undefined {
    const value = this.get(messageId);
    if (!value || (predicate && !predicate(value))) return undefined;
    this.values.delete(messageId);
    return value;
  }

  delete(messageId: string): void {
    this.values.delete(messageId);
  }

  /** 清理过期记录以及 predicate 判定已失效的 owner/session 记录。 */
  prune(predicate?: (value: T) => boolean, atMs = this.now()): void {
    const now = atMs;
    for (const [messageId, value] of this.values) {
      if (value.expiresAtMs <= now || (predicate && !predicate(value))) {
        this.values.delete(messageId);
      }
    }
  }

  clear(): void {
    this.values.clear();
  }
}
