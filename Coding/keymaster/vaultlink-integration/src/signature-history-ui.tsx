import { useEffect, useState } from "react";
import { Button } from "@keymaster/ui";
import type { SignatureRecord } from "./signature-history.js";
const PAGE_SIZE = 10;

export function SignatureHistoryPanel({
  load,
  text,
}: {
  load(): Promise<unknown>;
  text(key: string, fallback: string): string;
}) {
  const [rows, setRows] = useState<SignatureRecord[]>([]),
    [error, setError] = useState(""),
    [filter, setFilter] = useState("all"),
    [page, setPage] = useState(0);
  useEffect(() => {
    setRows([]);
    setPage(0);
    setError("");
    let active = true,
      reading = false;
    const refresh = async () => {
      if (reading) return;
      reading = true;
      try {
        const value = await load();
        if (!Array.isArray(value)) throw Error("invalid-signature-history");
        if (active) {
          setRows(value);
          setError("");
        }
      } catch (e) {
        if (active) setError(e instanceof Error ? e.message : String(e));
      } finally {
        reading = false;
      }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 2000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [load]);
  const modes = {
    automatic: text("automatic", "自动授权"),
    manual: text("manual", "手动确认"),
    unknown: text("unreported", "未报告"),
  };
  const states = {
    pending: text("pending", "等待结果"),
    completed: text("completed", "签名成功"),
    denied: text("denied", "已拒绝"),
    cancelled: text("cancelled", "已取消"),
    failed: text("failed", "失败"),
    unknown: text("unknown", "结果未知"),
  };
  const purposes: Record<string, string> = {
    "connect.identity-sign": text("connectIdentity", "App 连接身份签名"),
    "connect.intent-sign": text("connectIntent", "App 意图签名"),
    "bitfs.wire-sign": text("bitfsWire", "BitFS 协议签名"),
    "channel.public-message": text("publicMessage", "公开通信签名"),
    "channel.hash-request": text("hashRequest", "通信摘要签名"),
    "channel.private-message": text("privateMessage", "私密通信签名"),
    "software.digest-sign": text("digest", "摘要签名"),
    "identity.noise-proof": text("noise", "网络握手身份"),
    "identity.peer-record": text("peerRecord", "网络身份广播"),
    "sign-p2pkh": text("p2pkh", "P2PKH 交易"),
    "sign-standard": text("standard", "BSV 交易"),
    "sign-feepool": text("feepool", "费用池交易"),
    "tx.p2pkh-payment": text("p2pkh", "P2PKH 交易"),
    "tx.standard-payment": text("standard", "BSV 交易"),
    "tx.feepool-connect": text("feepool", "Connect 费用池交易"),
    "tx.feepool-bitfs": text("feepoolBitfs", "BitFS 费用池交易"),
  };
  const shown = rows.filter((r) =>
    filter === "all" || filter === "abnormal"
      ? filter === "all" ||
        ["denied", "cancelled", "failed", "unknown"].includes(r.state)
      : r.mode === filter,
  );
  // Clamp after refresh/filter changes without losing the user's selected page on each poll.
  const pageCount = Math.max(1, Math.ceil(shown.length / PAGE_SIZE));
  const currentPage = Math.min(page, pageCount - 1);
  useEffect(() => {
    if (page >= pageCount) setPage(pageCount - 1);
  }, [page, pageCount]);
  const visible = shown.slice(
    currentPage * PAGE_SIZE,
    (currentPage + 1) * PAGE_SIZE,
  );
  return (
    <section
      className="signature-history"
      aria-label={text("title", "签名记录")}
    >
      <header className="signature-history__header">
        <div>
          <h2>{text("title", "签名记录")}</h2>
          <p>
            {text("scope", "这里只记录 Keymaster 经手的请求，硬件不保存历史。")}
          </p>
        </div>
        <span className="signature-history__count">
          {text("records", "记录数")} · {shown.length}
        </span>
      </header>
      <div
        className="signature-history__filters"
        aria-label={text("filter", "筛选记录")}
      >
        {[
          ["all", "全部"],
          ["automatic", "自动授权"],
          ["manual", "手动确认"],
          ["abnormal", "异常"],
        ].map(([value, label]) => (
          <Button
            key={value}
            variant={filter === value ? "primary" : "ghost"}
            aria-pressed={filter === value}
            onClick={() => {
              setFilter(value!);
              setPage(0);
            }}
          >
            {text(value!, label!)}
          </Button>
        ))}
      </div>
      {error ? (
        <p className="vault-page__error" role="alert">
          {error}
        </p>
      ) : null}
      <div
        className="signature-history__table-wrap"
        role="region"
        aria-label={text("title", "签名记录")}
        tabIndex={0}
      >
        <table className="signature-history__table">
          <thead>
            <tr>
              <th scope="col">{text("time", "请求时间")}</th>
              <th scope="col">{text("purpose", "用途 / 渠道")}</th>
              <th scope="col">{text("source", "来源 / 私钥")}</th>
              <th scope="col">{text("amount", "金额 (sat)")}</th>
              <th scope="col">{text("authorization", "授权方式")}</th>
              <th scope="col">{text("result", "结果")}</th>
            </tr>
          </thead>
          <tbody>
            {visible.length === 0 ? (
              <tr>
                <td colSpan={6} className="signature-history__empty">
                  {text("empty", "暂无签名记录")}
                </td>
              </tr>
            ) : null}
            {visible.map((r) => (
              <tr key={r.id}>
                <td className="signature-history__time">
                  <time dateTime={r.startedAt}>
                    {new Date(r.startedAt).toLocaleString()}
                  </time>
                </td>
                <td>
                  <strong>{purposes[r.operation] ?? r.operation}</strong>
                  <code>{r.channelId}</code>
                </td>
                <td>
                  <span>{r.owner}</span>
                  <small>
                    {r.backend === "hardware"
                      ? text("hardware", "硬私钥")
                      : text("software", "软私钥")}
                  </small>
                </td>
                <td className="signature-history__amount">{r.amount ?? "—"}</td>
                <td>
                  <span className="signature-history__mode">
                    {modes[r.mode]}
                  </span>
                </td>
                <td>
                  <span
                    className={`signature-history__status signature-history__status--${r.state}`}
                  >
                    {states[r.state]}
                  </span>
                  {r.finishedAt ? (
                    <small title={text("finished", "完成时间")}>
                      <time dateTime={r.finishedAt}>
                        {new Date(r.finishedAt).toLocaleTimeString()}
                      </time>
                    </small>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <footer className="signature-history__pagination">
        <span>
          {text("perPage", "每页 10 条")} ·{" "}
          {shown.length ? currentPage * PAGE_SIZE + 1 : 0}–
          {Math.min((currentPage + 1) * PAGE_SIZE, shown.length)} /{" "}
          {shown.length}
        </span>
        <nav aria-label={text("pagination", "签名记录分页")}>
          <Button
            variant="ghost"
            disabled={currentPage === 0}
            onClick={() => setPage(currentPage - 1)}
          >
            {text("previous", "上一页")}
          </Button>
          <span>
            {currentPage + 1} / {pageCount}
          </span>
          <Button
            variant="ghost"
            disabled={currentPage + 1 >= pageCount}
            onClick={() => setPage(currentPage + 1)}
          >
            {text("next", "下一页")}
          </Button>
        </nav>
      </footer>
    </section>
  );
}
