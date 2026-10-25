import { useEffect, useRef, useState } from "react";
import type { P2pkhCoordinatorControl, P2pkhConclusionRow } from "@keymaster/contracts";
import { Button } from "@keymaster/ui";

/** Mount/poll only reads state. Only the explicit button starts retransmission. */
export function P2pkhConclusionPanel({ coordinator, owner, network }: {
  coordinator: P2pkhCoordinatorControl; owner: string; network: "main" | "test";
}) {
  const [items, setItems] = useState<P2pkhConclusionRow[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<string>();
  const [revision, setRevision] = useState(0);
  const scope = useRef(`${owner}:${network}`);
  scope.current = `${owner}:${network}`;
  useEffect(() => { scope.current = `${owner}:${network}`; return () => { scope.current = ""; }; }, [owner, network]);
  useEffect(() => {
    let live = true;
    let loading = false;
    setItems([]); setError(""); setBusy(undefined);
    async function read() {
      if (loading) return;
      loading = true;
      try {
        const result = await coordinator.p2pkhConclusion({ action: "list", ownerPublicKeyHex: owner, network });
        if (!live) return;
        if (result.status !== "ok") throw new Error("message" in result ? String(result.message) : "无法读取未决交易");
        setItems(result.value.items); setError("");
      } catch (cause) { if (live) setError(cause instanceof Error ? cause.message : String(cause)); }
      finally { loading = false; }
    }
    void read();
    const timer = setInterval(() => { void read(); }, 2000);
    return () => { live = false; clearInterval(timer); };
  }, [coordinator, owner, network, revision]);
  async function act(action: "start" | "stop" | "recover", allocationId: string) {
    const capturedOwner = owner;
    const capturedScope = scope.current;
    setBusy(allocationId); setError("");
    try {
      const result = await coordinator.p2pkhConclusion({ action, allocationId, ownerPublicKeyHex: owner, network });
      if (scope.current !== capturedScope || coordinator.getActivePublicKeyHex()?.toLowerCase() !== capturedOwner.toLowerCase()) return;
      if (result.status !== "ok") throw Error("message" in result ? String(result.message) : "查询操作失败");
      setItems(result.value.items);
    } catch (cause) { if (scope.current === capturedScope) setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { if (scope.current === capturedScope) setBusy(undefined); }
  }
  return <section aria-label="原交易结论查询" className="p2pkh-conclusions">
    <h3>原交易结论查询</h3>
    <p>“查询”会定时重交原交易，不重新选币、签名或变更费用。重启后不会自动启动；停止查询不释放未决资金。</p>
    <Button variant="secondary" onClick={() => setRevision(value => value + 1)}>刷新状态（只读）</Button>
    {error && <p role="alert">{error}</p>}
    {items.length === 0 && !error && <p>暂无原交易记录</p>}
    {items.map(row => <article key={row.allocationId}>
      <p><code>{row.txid || "尚无完整签名交易 ID"}</code> · {row.signingState ? "签名状态待恢复" : row.retryable === false && row.state !== "done" ? "当前禁止派发" : row.state === "failed" ? "原申请失败" : row.state === "done" ? "已成功" : row.queryState === "running" ? "查询中" : "待手工查询"}</p>
      <small>申请：{row.allocationId}</small>
      {row.signingState && <div><p>签名执行待恢复；仍保护 {row.heldSats} sat，输入：{row.heldInputs?.join("、")}</p>
        <Button variant="secondary" disabled={busy === row.allocationId} onClick={() => void act("recover", row.allocationId)}>恢复签名执行证据（不广播）</Button>
      </div>}
      {row.conclusion && <div>
        <p>原因：输入已被其他交易消费。历史已恢复金额：{row.conclusion.releasedSats} sat（不是当前余额）。</p>
        <p>已恢复输入：{row.conclusion.releasedInputs.join("、") || "无"}</p>
        <p>仍保护输入：{row.conclusion.heldInputs.join("、") || "无"}</p>
        {row.conclusion.spentInputs.map(fact => <p key={fact.outpoint}>已花：{fact.outpoint} → {fact.txid}（{fact.confirmed === true ? "已确认" : fact.confirmed === false ? "未确认" : "确认状态未知"}）</p>)}
      </div>}
      {row.error && <p role="alert">查询已暂停：{row.error}</p>}
      {row.delivery === "external" ? <p>外露签名责任：仅观察，不由此入口重交。</p> : row.state !== "done" && row.state !== "failed" && <Button
        variant="secondary" disabled={busy === row.allocationId || (row.queryState !== "running" && (row.retryable === false || !row.txid))}
        onClick={() => void act(row.queryState === "running" ? "stop" : "start", row.allocationId)}>
        {row.queryState === "running" ? "停止查询" : "查询（会重交原交易）"}
      </Button>}
    </article>)}
  </section>;
}
