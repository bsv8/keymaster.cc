import { useOptionalPluginCapability } from "webloom-framework/react";
import { MSFILE_BUCKET_SERVICE_CAPABILITY } from "./msfileBucketService.js";
import { useEffect, useState } from "react";
import type { MsFileService, MsFileBitfsDemandSnapshot, MsFileBitfsQuoteView, MsFileBitfsTaskSnapshot } from "@keymaster/contracts";
import { AppLink } from "@keymaster/runtime";
import { Button } from "@keymaster/ui";

const money = (value: string | null | undefined) => value == null ? "待确定" : `${BigInt(value).toLocaleString()} sats`;
const short = (value: string) => `${value.slice(0, 10)}…${value.slice(-6)}`;
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

/** 报价与费用只读展示；购买沿用后端按剩余内容和卖家分配预算的原入口。 */
export function MsFilePurchasePanel({ service, demand, maximumPrice, onPurchase }: {
  service: MsFileService; demand: MsFileBitfsDemandSnapshot; maximumPrice: string | null;
  onPurchase(sessionId: string): Promise<void>;
}) {
  const purchase = demand.purchase;
  return <section className="msfile-market" aria-label="卖家与购买配置">
    <header className="msfile-section-heading"><div><h4>卖家报价</h4><p>比较单价与最近速度，选择卖家购买文件。</p></div><span>{demand.quotes.length} 位卖家</span></header>
    {demand.quotes.length ? <div className="msfile-table-scroll"><table className="msfile-market__table msfile-market__table--quotes">
      <caption className="sr-only">已验签卖家报价</caption>
      <thead><tr><th>卖家</th><th className="numeric">Seed 单价</th><th className="numeric">完整 Block 单价</th><th>最近速度</th><th>文件内容费参考</th><th>购买</th></tr></thead>
      <tbody>{demand.quotes.map(quote => {
        const samePurchase = purchase?.sessionId === quote.sessionId;
        const emptyFile = BigInt(quote.fileSizeBytes) === 0n;
        const aboveLimit = maximumPrice === null || BigInt(quote.fullBlockPriceSatoshis) > BigInt(maximumPrice);
        const hasArbiter = quote.supportedArbiterPublicKeys.length > 0;
        // 保留原报价按钮的购买状态判断，不增加费用预览、余额预检或新的准入条件。
        const blockedByOtherPurchase = Boolean(purchase && !samePurchase
          && purchase.phase !== "cancelled" && purchase.phase !== "refunded" && purchase.phase !== "failed" && purchase.phase !== "connection-closed");
        const disabled = !service.startBitfsPurchase || emptyFile || !hasArbiter || aboveLimit || blockedByOtherPurchase || samePurchase;
        const reference = quoteContentReference(quote);
        const label = emptyFile ? "暂不支持购买空文件" : aboveLimit ? "超过本文件已选上限" : !hasArbiter ? "此报价没有可用仲裁方" : samePurchase ? purchase?.phase === "completed" ? "购买完成" : "查看购买进度" : blockedByOtherPurchase ? purchase?.phase === "completed" ? "该 Seed 已购买" : "请先完成当前购买" : "购买此报价";
        return <tr key={quote.sessionId}>
          <th scope="row"><code title={quote.sellerPublicKeyHex}>{short(quote.sellerPublicKeyHex)}</code><details><summary>报价详情与费用</summary><QuoteBill quote={quote} /></details></th>
          <td data-label="Seed 单价" className="numeric">{money(quote.seedPriceSatoshis)}</td>
          <td data-label="完整 Block 单价" className="numeric">{money(quote.fullBlockPriceSatoshis)}</td>
          <td data-label="最近速度">{quote.recentBytesPerSecond == null ? "未知" : `${(Number(quote.recentBytesPerSecond) / 1024).toFixed(1)} KiB/s`}</td>
          <td data-label="文件内容费参考" className="numeric">{money(reference)}<small>整份文件内容费上界</small></td>
          <td><Button size="sm" disabled={disabled} onClick={() => void onPurchase(quote.sessionId)}>{label}</Button>{samePurchase ? <AppLink to={`/msfile/purchases/${encodeURIComponent(quote.sessionId)}`}>查看购买详情</AppLink> : null}</td>
        </tr>;
      })}</tbody>
    </table></div> : !demand.existingPurchaseSessionId ? <p className="msfile-empty" role="status">需求已发出，尚未收到有效报价；页面会继续刷新报价。</p> : null}
    <p className="msfile-checkout__help">内容费参考按 Seed 和文件块单价计算；实际按剩余内容在卖家间分配采购预算，另计仲裁预留与链上费用。关池余款退回钱包。</p>
    {purchase || demand.existingPurchaseSessionId ? <PurchaseProgress key={demand.seedHashHex} demand={demand} /> : null}
    <details className="msfile-market__discovery"><summary>查询详情</summary><dl className="msfile-checkout__details">
      <div><dt>需求编号</dt><dd><code>{demand.requestMessageId ?? "—"}</code></dd></div>
      <div><dt>需求有效至</dt><dd>{demand.expiresAtMs ? new Date(demand.expiresAtMs).toLocaleString() : "—"}</dd></div>
    </dl></details>
  </section>;
}

function quoteContentReference(quote: MsFileBitfsQuoteView): string {
  const blocks = (BigInt(quote.fileSizeBytes) + 262143n) / 262144n;
  return (BigInt(quote.seedPriceSatoshis) + blocks * BigInt(quote.fullBlockPriceSatoshis)).toString();
}

function QuoteBill({ quote }: { quote: MsFileBitfsQuoteView }) {
  const row = (label: string, value: string, hint?: string) => <div className="msfile-bill__row"><dt>{label}{hint ? <small>{hint}</small> : null}</dt><dd>{value}</dd></div>;
  return <div className="msfile-bill">
    <dl className="msfile-bill__lines">
      {row("Seed 单价", money(quote.seedPriceSatoshis))}
      {row("完整 Block 单价", money(quote.fullBlockPriceSatoshis))}
      {row("文件块数", ((BigInt(quote.fileSizeBytes) + 262143n) / 262144n).toString())}
      {row("文件内容费参考上界", money(quoteContentReference(quote)), "Seed 单价＋文件块数×完整块单价；尾块按实际长度计价，已验收内容不重复购买")}
      {row("仲裁基础费", "待确定", "一次仲裁请求的固定费用")}
      {row("仲裁条目费", "待确定", "每条费用 × 本次仲裁条目数")}
      {row("仲裁预留", "待确定", "基础费＋条目费；正常完成不支付仲裁费")}
      {row("结算矿工费", "待确定", "结算交易字节数 × 矿工费率，向上取整")}
      {row("费用池金额", "待确定", "本池分配的内容预算＋仲裁预留＋结算矿工费")}
      {row("开池矿工费", "待确定", "开池交易字节数 × 矿工费率，向上取整")}
      {row("需动用钱包金额", "待确定", "费用池金额＋开池矿工费；含关池可退回的余款")}
    </dl>
    <p className="msfile-checkout__help">具体费用在开池准备过程中确定，已确定金额见购买进度与结算详情。未确定金额不代表零。</p>
    <dl className="msfile-checkout__details">
      <div><dt>报价有效至</dt><dd>{new Date(Number(quote.quoteExpiresAtUnixSeconds) * 1000).toLocaleString()}</dd></div>
      <div><dt>每批最多</dt><dd>{quote.maxBlocksPerBatch} 个 Block</dd></div>
      <div><dt>可选仲裁方</dt><dd>{quote.supportedArbiterPublicKeys.length} 位</dd></div>
      <div><dt>卖家公钥</dt><dd><code>{quote.sellerPublicKeyHex}</code></dd></div>
    </dl>
  </div>;
}

function PurchaseProgress({ demand }: { demand: MsFileBitfsDemandSnapshot }) {
  const bucket = useOptionalPluginCapability(MSFILE_BUCKET_SERVICE_CAPABILITY);
  const [records, setRecords] = useState<MsFileBitfsTaskSnapshot[]>([]);
  const [error, setError] = useState("");
  const sessionId = demand.existingPurchaseSessionId ?? demand.purchase?.sessionId;
  useEffect(() => {
    let cancelled = false, running = false;
    const load = async () => {
      if (running || !bucket?.listBitfsTasks) return;
      running = true;
      try {
        const all = await bucket.listBitfsTasks();
        const current = all.find(item => item.sessionId === sessionId);
        const related = current?.taskId ? all.filter(item => item.taskId === current.taskId) : all.filter(item => item.sessionId === sessionId);
        if (!cancelled) { setRecords(related); setError(""); }
      } catch (cause) { if (!cancelled) setError(errorText(cause)); }
      finally { running = false; }
    };
    void load(); const timer = setInterval(() => void load(), 5000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [bucket, sessionId]);
  const current = records.find(item => item.sessionId === sessionId);
  const progress = current ?? demand.purchase;
  return <section className="msfile-execution" aria-label="内容进度与资金结算">
    <header className="msfile-section-heading"><div><h4>当前购买任务</h4><p>{progress?.message ?? "该文件已有进行中采购任务，请前往购买详情管理。"}</p></div><AppLink to={`/msfile/purchases/${encodeURIComponent(sessionId ?? "")}`}>管理任务</AppLink></header>
    {demand.purchase?.feeBreakdown ? <dl className="msfile-bill__lines" aria-label="已计算费用分项">
      {([
        ["内容额度", demand.purchase.feeBreakdown.contentBudgetSatoshis],
        ["仲裁基础费", demand.purchase.feeBreakdown.arbitrationBaseSatoshis],
        [`仲裁条目费（每条 ${demand.purchase.feeBreakdown.arbitrationPerItemSatoshis} sats × ${demand.purchase.feeBreakdown.arbitrationItemCount}）`, (BigInt(demand.purchase.feeBreakdown.arbitrationPerItemSatoshis) * BigInt(demand.purchase.feeBreakdown.arbitrationItemCount)).toString()],
        ["仲裁预留小计", demand.purchase.feeBreakdown.arbitrationReserveSatoshis],
        ["结算矿工费预留", demand.purchase.feeBreakdown.settlementReserveSatoshis],
      ] as const).map(([label, amount]) => <div className="msfile-bill__row" key={label}><dt>{label}</dt><dd>{money(amount)}</dd></div>)}
    </dl> : null}
    <div className="msfile-execution__summary"><div><span>内容验收</span><strong>{progress?.verifiedBlockCount ?? "—"} / {progress?.totalBlockCount ?? "—"} Block</strong></div><div><span>资金结算</span><strong>{records.length && records.every(item => item.fundingState === "closed") ? "费用池已结清" : "逐池核对中"}</strong></div></div>
    {demand.purchase?.openingAmountSatoshis != null ? <p>本池开池金额：{money(demand.purchase.openingAmountSatoshis)}</p> : null}
    <p className="msfile-checkout__help">内容验收与资金结算分别记录；池外找零和已到账退款可正常使用。</p>
    {error ? <p role="status">资金明细暂不可读：{error}</p> : null}
    {records.length ? <div className="msfile-table-scroll"><table className="msfile-market__table"><caption>各卖家费用池</caption><thead><tr><th>卖家</th><th>资金状态</th><th className="numeric">已签应付卖家</th><th className="numeric">已知／预计矿工费</th><th className="numeric">池内资金</th><th className="numeric">待到账回款</th><th>操作</th></tr></thead><tbody>{records.map(item => <tr key={item.sessionId}><th><code>{item.sellerPublicKeyHex ? short(item.sellerPublicKeyHex) : "—"}</code></th><td>{({ "not-opened": "尚未开池", open: "池内结算中", closed: "已结清", unknown: "待核对" })[item.fundingState ?? "unknown"]}</td><td className="numeric">{money(item.paidSatoshis)}</td><td className="numeric">{money(item.minerFeeSatoshis)}</td><td className="numeric">{money(item.lockedSatoshis)}</td><td className="numeric">{money(item.pendingReturnSatoshis)}</td><td><AppLink to={`/msfile/purchases/${encodeURIComponent(item.sessionId)}`}>结算详情</AppLink></td></tr>)}</tbody></table></div> : <p role="status">正在读取逐池资金明细…</p>}
    <details><summary>金额口径</summary><p>已签应付卖家是本地付款承诺，尚不代表已上链；池内资金可能包含这笔应付金额。待到账回款属于池内待结算的一部分，以上列不能相加作为资产总额。矿工费包含开池已知费用和当前结算候选的预计费用，最终以已观察的结算交易为准。</p></details>
  </section>;
}
