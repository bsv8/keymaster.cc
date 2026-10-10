import { useEffect, useState } from "react";
export { HardwareConnectionPanel } from "./hardware-connection-ui.js";
import { Button, Modal, TextInput } from "@keymaster/ui";
import type {
  WalletPaymentCommand,
  PaymentChannelDTO,
} from "./wallet-payments.js";
export interface PaymentUIProps {
  execute(command: WalletPaymentCommand): Promise<unknown>;
  text(key: string, fallback: string): string;
}
export function PaymentChannelSettings({ execute, text }: PaymentUIProps) {
  const [channels, setChannels] = useState<PaymentChannelDTO[]>([]);
  const [editing, setEditing] = useState<PaymentChannelDTO>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    void execute({ action: "list" }).then(
      (v) => {
        if (live) setChannels(v as PaymentChannelDTO[]);
      },
      (e) => {
        if (live) setError(String(e));
      },
    );
    return () => {
      live = false;
    };
  }, [execute]);
  async function save() {
    if (!editing) return;
    setBusy(true);
    setError("");
    try {
      const channel = { ...editing, revision: editing.revision + 1 };
      await execute({ action: "configure", channel });
      setChannels((await execute({ action: "list" })) as PaymentChannelDTO[]);
      setEditing(undefined);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section>
      <h2>{text("payment.channels", "支付渠道")}</h2>
      {error ? <p role="alert">{error}</p> : null}
      {channels.length === 0 ? (
        <p>{text("payment.empty", "尚无已注册的支付渠道")}</p>
      ) : null}
      {channels.map((c) => (
        <div key={c.id}>
          <p>
            {c.id} · {c.owner} · {c.kind}
          </p>
          <p>
            {text("payment.single", "单笔免确认额度（聪）")}：{c.singleLimit}
          </p>
          {c.kind === "app" ? (
            <p>
              {text("payment.default", "新会话累计免确认额度（聪）")}：
              {c.defaultSessionLimit}
            </p>
          ) : null}
          <Button onClick={() => setEditing({ ...c })}>
            {text("payment.edit", "修改额度")}
          </Button>
        </div>
      ))}
      {editing ? (
        <Modal
          open
          title={text("payment.edit", "修改额度")}
          onClose={() => {
            if (!busy) setEditing(undefined);
          }}
          footer={
            <>
              <Button disabled={busy} onClick={() => setEditing(undefined)}>
                {text("payment.cancel", "取消")}
              </Button>
              <Button disabled={busy} onClick={() => void save()}>
                {text("payment.save", "保存额度")}
              </Button>
            </>
          }
        >
          <p>
            {editing.id} · {editing.owner}
          </p>
          <TextInput
            label={text("payment.single", "单笔免确认额度（聪）")}
            inputMode="numeric"
            value={editing.singleLimit}
            onChange={(e) =>
              setEditing({ ...editing, singleLimit: e.currentTarget.value })
            }
          />
          {editing.kind === "app" ? (
            <TextInput
              label={text("payment.default", "新会话累计免确认额度（聪）")}
              inputMode="numeric"
              value={editing.defaultSessionLimit}
              onChange={(e) =>
                setEditing({
                  ...editing,
                  defaultSessionLimit: e.currentTarget.value,
                })
              }
            />
          ) : null}
          <label>
            <input
              type="checkbox"
              checked={editing.enabled}
              onChange={(e) =>
                setEditing({ ...editing, enabled: e.currentTarget.checked })
              }
            />
            {text("payment.enabled", "启用免确认")}
          </label>
        </Modal>
      ) : null}
    </section>
  );
}
interface Pending {
  id: string;
  channelId: string;
  owner: string;
  kind: "app" | "plugin";
  amount: string;
  used: string;
  singleLimit: string;
  sessionLimit: string | null;
  reasons: string[];
  recipients: string[];
  fee: string;
  change: string;
  pool?: { family: string; stage: string; paid: string; locked: string };
}
export function PaymentApprovalDialog({ execute, text }: PaymentUIProps) {
  const [pending, setPending] = useState<Pending[]>([]);
  const [raised, setRaised] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const request = pending[0];
  useEffect(() => {
    setRaised("");
    setError("");
  }, [request?.id]);
  useEffect(() => {
    let live = true,
      fetching = false;
    const refresh = async () => {
      if (fetching) return;
      fetching = true;
      try {
        const value = await execute({ action: "pending" });
        if (live) setPending(value as Pending[]);
      } catch (e) {
        if (live) {
          setPending([]);
          setError(String(e));
        }
      } finally {
        fetching = false;
      }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 500);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [execute]);
  async function answer(allow: boolean, increase = false) {
    if (!request) return;
    setBusy(true);
    setError("");
    try {
      await execute({
        action: "answer",
        id: request.id,
        allow,
        ...(increase ? { raiseSessionLimit: raised } : {}),
      });
      setPending((p) => p.filter((v) => v.id !== request.id));
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  if (!request) return null;
  return (
    <Modal
      open
      title={text("payment.approval", "付款超过免确认额度")}
      onClose={() => {
        if (!busy) void answer(false);
      }}
      footer={
        <>
          <Button disabled={busy} onClick={() => void answer(false)}>
            {text("payment.deny", "拒绝")}
          </Button>
          <Button disabled={busy} onClick={() => void answer(true)}>
            {text("payment.once", "仅批准本次")}
          </Button>
          {request.reasons.includes("session-limit") ? (
            <Button
              disabled={busy || !raised}
              onClick={() => void answer(true, true)}
            >
              {text("payment.raiseApprove", "提高本会话额度并批准")}
            </Button>
          ) : null}
        </>
      }
    >
      <p>
        {request.owner} · {request.channelId}
      </p>
      <p>
        {text("payment.amount", "支付金额（聪）")}：{request.amount}
      </p>
      <p>
        {text("payment.change", "本 Key 找零（聪）")}：{request.change}
      </p>
      <p>
        {text("payment.fee", "矿工费（聪，不计入渠道额度）")}：{request.fee}
      </p>
      {request.pool ? (
        <div>
          <p>
            {text("payment.pool", "费用池")}：
            {request.pool.family === "connect" ? "Connect" : "BitFS"} ·{" "}
            {request.pool.stage === "fund"
              ? text("payment.poolFund", "资金存入")
              : text("payment.poolState", "累计状态交易")}
          </p>
          <p>
            {text("payment.poolPaid", "池内累计对外付款（聪）")}：
            {request.pool.paid}
          </p>
          <p>
            {text("payment.poolLocked", "本次存入池内金额（聪）")}：
            {request.pool.locked}
          </p>
        </div>
      ) : null}
      <p>
        {text("payment.single", "单笔免确认额度（聪）")}：{request.singleLimit}
      </p>
      {request.kind === "app" ? (
        <p>
          {text("payment.cumulative", "会话已用／本次后累计／额度")}：
          {request.used} /{" "}
          {String(BigInt(request.used) + BigInt(request.amount))} /{" "}
          {request.sessionLimit}
        </p>
      ) : null}
      <p>
        {request.reasons
          .map((r) =>
            r === "single-limit"
              ? text("payment.singleExceeded", "超过单笔额度")
              : r === "session-limit"
                ? text("payment.sessionExceeded", "超过会话累计额度")
                : text("payment.disabled", "免确认已关闭"),
          )
          .join("；")}
      </p>
      <p>{text("payment.outputs", "实际交易输出（含找零）")}</p>
      <div
        style={{ maxHeight: 180, overflowY: "auto", overflowWrap: "anywhere" }}
      >
        {request.recipients.map((r, i) => (
          <p key={i}>{r}</p>
        ))}
      </div>
      {request.reasons.includes("session-limit") ? (
        <TextInput
          label={text("payment.raise", "提高当前会话累计额度（聪）")}
          inputMode="numeric"
          value={raised}
          onChange={(e) => setRaised(e.currentTarget.value)}
        />
      ) : null}
      {error ? <p role="alert">{error}</p> : null}
    </Modal>
  );
}
