import type { ProtocolCommandRecord, ProtocolMethod } from "./protocol.js";

/** 面向用户的应用操作名称，不暴露协议方法标识。 */
export const APPLICATION_OPERATION_LABELS: Partial<Record<ProtocolMethod, string>> = {
  "connect.login": "连接钱包", "connect.launch": "打开应用", "connect.logout": "断开连接",
  "identity.get": "获取身份凭证", "intent.sign": "签名", "cipher.encrypt": "加密内容", "cipher.decrypt": "解密内容",
  "payment.pay": "付款", "payment.status": "查询付款结果", "feepool.prepare": "准备服务付款", "feepool.commit": "提交服务付款",
  "channel.publish": "发布消息", "channel.subscription_set": "更新订阅", "msfile.stat": "查看文件", "msfile.seed.read": "读取文件信息", "msfile.block.read": "读取文件内容",
};
export function applicationCommandTerminal(command: ProtocolCommandRecord): boolean {
  return ["approved", "rejected", "failed", "timed_out"].includes(command.phase);
}
export function applicationCommandStatus(command: ProtocolCommandRecord): string {
  if (command.paymentStatus) {
    if (["accepted", "already_known"].includes(command.paymentStatus)) return "节点已接受";
    if (command.paymentStatus === "not_signed") return "未签名";
    if (command.paymentStatus === "failed") return "付款失败";
    return "付款待核实";
  }
  if (command.status === "timed_out" || command.failureReason === "request_timeout" || command.phase === "timed_out") return "已超时";
  return ({ approved: "已完成", rejected: "已拒绝", failed: "失败", executing: "处理中", queued: "排队中", confirming: "等待授权", waiting_unlock_manual: "等待解锁", waiting_unlock_auto: "等待解锁" } as Record<string, string>)[command.phase] ?? "等待处理";
}

