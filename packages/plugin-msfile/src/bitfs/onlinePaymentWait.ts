/** 仅本次在线实例拥有的付款等待。没有持久化扫描、启动补跑或自动重试。 */
export class OnlinePaymentWait {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly deliveries = new Map<string, string>();
  arm(id: string, timeoutSeconds: number, expired: () => Promise<void>, deliveryId = id): void {
    if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0 || timeoutSeconds > 86400) throw new Error("付款等待时间不合法");
    if (this.deliveries.get(id) === deliveryId) return;
    this.cancel(id);
    this.deliveries.set(id, deliveryId);
    this.timers.set(id, setTimeout(() => {
      this.timers.delete(id);
      // 编排层负责保存失败状态；这里不自动重试，且不能产生未处理的 Promise。
      void expired().catch(() => undefined);
    }, timeoutSeconds * 1000));
  }
  cancel(id: string): void { clearTimeout(this.timers.get(id)); this.timers.delete(id); }
  clear(): void { for (const timer of this.timers.values()) clearTimeout(timer); this.timers.clear(); this.deliveries.clear(); }
}
