import { useEffect, useRef, useState } from "react";
import { AppLink } from "@keymaster/runtime";
import type { MsFileBitfsFundingPoolSnapshot } from "@keymaster/contracts";
import type { MsFileBucketService } from "./msfileBucketService.js";

const money = (amount: string | null) => amount === null ? "待核对" : `${amount} sats`;
const states = { "opening-presign": "开池预签待处理", "funding-pending": "开池结果待核对", "funding-failed": "开池未成功，待核对释放", open: "费用池未关闭", "recovery-pending": "回款结果待核对", closed: "池已关闭" };
/** 费用池始终从独立资金账本读取；采购历史删除与否不改变其来源。 */
export function MsFileFundingPoolsTable({ service, revision = 0 }: { service: MsFileBucketService; revision?: number }) {
  const [pools, setPools] = useState<MsFileBitfsFundingPoolSnapshot[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const request = useRef(0);
  useEffect(() => {
    let mounted = true;
    const load = async () => {
      const version = ++request.current;
      if (!service.listBitfsFundingPools) { setLoading(false); return; }
      try {
        const next = await service.listBitfsFundingPools();
        if (mounted && version === request.current) { setPools(next.filter(p => p.needsRecovery || p.historyDeleted)); setError(""); }
      } catch (cause) { if (mounted && version === request.current) setError(cause instanceof Error ? cause.message : String(cause)); }
      finally { if (mounted && version === request.current) setLoading(false); }
    };
    void load(); const timer = setInterval(() => void load(), 5000);
    return () => { mounted = false; request.current++; clearInterval(timer); };
  }, [service, revision]);
  return <section className="msfile-purchases__funding" id="pending-pools" aria-label="待处理费用池">
    <h3>待处理费用池</h3>
    <p>费用池在任务执行时独立记录。删除文件或采购历史后，未结清资金仍在这里管理；删除操作不会自动关池或退款。</p>
    {error ? <p role="alert">费用池读取失败：{error}</p> : null}
    {loading ? <p role="status">正在读取费用池账本…</p> : null}
    {!loading && !error && !pools.length ? <p>当前没有待处理费用池。</p> : null}
    {pools.length ? <div className="msfile-purchases__scroll"><table className="msfile-purchases__table"><thead><tr><th>关联文件</th><th>卖家</th><th>状态</th><th className="numeric">池金额</th><th className="numeric">池内资金</th><th className="numeric">待到账回款</th><th>操作</th></tr></thead>
      <tbody>{pools.map(pool => <tr key={`${pool.network}:${pool.poolId}`}><td title={pool.seedHashHex}>{pool.recommendedFilename ?? `${pool.seedHashHex.slice(0, 12)}…`}{pool.historyDeleted ? <small> · 采购历史已删除</small> : null}</td><td><code title={pool.sellerPublicKeyHex ?? ""}>{pool.sellerPublicKeyHex ? `${pool.sellerPublicKeyHex.slice(0, 10)}…` : "待核对"}</code></td><td>{states[pool.state]}{pool.state === "closed" && pool.needsRecovery ? "，输入释放待核对" : ""}</td><td className="numeric">{money(pool.poolAmountSatoshis)}</td><td className="numeric">{money(pool.lockedSatoshis)}</td><td className="numeric">{money(pool.pendingReturnSatoshis)}</td><td>{pool.canManage ? <AppLink to={`/msfile/purchases/${encodeURIComponent(pool.poolId)}`}>{pool.needsRecovery ? "管理资金" : "清理已结清记录"}</AppLink> : "恢复证据缺失，需核查"}</td></tr>)}</tbody>
    </table></div> : null}
  </section>;
}
