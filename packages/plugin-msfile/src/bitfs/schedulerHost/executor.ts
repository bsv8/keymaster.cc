// 内核命令执行器：按 commandId 幂等路由到宿主端口；端口失败抛出，由调用方映射为错误事实。

import type { Command } from "keymaster.cc-download-scheduler";

/**
 * 宿主命令端口。实现方负责原子持久化与真实执行：
 * - 失败时必须抛出，调用方会把失败回灌为内核 `open-failed` / `unknown` 等事实；
 * - 执行前核对命令归属、合同、费用版本、资金与内容授权，不能简单要求任务 revision 永不变化。
 */
export interface SchedulerCommandPorts {
  /** 内核 open 意图：按执行层真实输入复算金额；与内核意图不一致时拒绝并回灌纠正。 */
  openPool(command: Extract<Command, { type: "open" }>): Promise<void>;
  /** 内核 download：把批次登记到下载计划并请求内容。 */
  dispatchDownload(command: Extract<Command, { type: "download" }>): Promise<void>;
  /** 内核 drain：停止该池新派发，在途请求继续完成。 */
  drainPool(command: Extract<Command, { type: "drain" }>): Promise<void>;
  /** 内核 close：请求关池回收。 */
  closePool(command: Extract<Command, { type: "close" }>): Promise<void>;
}

/** 按 commandId 幂等执行内核命令；同一宿主实例内不重复执行同一命令。 */
export class SchedulerCommandExecutor {
  private readonly executed = new Set<string>();

  constructor(private readonly ports: SchedulerCommandPorts) {}

  async run(command: Command): Promise<void> {
    if (this.executed.has(command.commandId)) return;
    this.executed.add(command.commandId);
    try {
      switch (command.type) {
        case "open": await this.ports.openPool(command); break;
        case "download": await this.ports.dispatchDownload(command); break;
        case "drain": await this.ports.drainPool(command); break;
        case "close": await this.ports.closePool(command); break;
      }
    } catch (error) {
      // 失败不保留去重记录：宿主决定重试或回灌错误事实后，命令仍可再次执行。
      this.executed.delete(command.commandId);
      throw error;
    }
  }

  /** 重启或事实确认后清空内存去重记录；outbox 才是跨重启的真相。 */
  forget(commandId?: string): void {
    if (commandId === undefined) this.executed.clear();
    else this.executed.delete(commandId);
  }
}
