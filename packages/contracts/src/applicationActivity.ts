import type { ProtocolCommandRecord, ProtocolMethod } from "./protocol.js";

/** 面向用户的应用操作名称，不暴露协议方法标识。 */
export const APPLICATION_OPERATION_LABELS: Record<ProtocolMethod, string> = {
  "connect.login": "连接钱包", "connect.launch": "打开应用", "connect.logout": "断开连接",
  "identity.get": "获取身份凭证", "intent.sign": "签名", "cipher.encrypt": "加密内容", "cipher.decrypt": "解密内容",
  "payment.pay": "付款", "payment.status": "查询付款结果",
  "payment.prepare": "准备分阶段付款", "payment.commit": "确认并提交分阶段付款", "payment.cancel": "取消分阶段付款",
  "feepool.prepare": "准备服务付款", "feepool.commit": "提交服务付款",
  "application.key": "获取应用密钥公钥", "application.sign_message": "使用应用密钥签署消息", "application.sign_payment": "使用应用密钥签署付款",
  "chain.get_height": "查询区块高度", "chain.list_script_history": "查询脚本交易历史",
  "chain.get_transaction": "查询链上交易", "chain.list_script_unspent": "查询脚本未花费输出", "chain.broadcast": "广播交易",
  "channel.publish": "发布消息", "channel.subscription_set": "更新订阅", "msfile.stat": "查看文件", "msfile.seed.read": "读取文件信息", "msfile.block.read": "读取文件内容",
  "msfile.seller.status": "查询文件售卖状态", "msfile.import": "导入并出售文件", "msfile.content.read": "读取文件（本地或购买）",
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

