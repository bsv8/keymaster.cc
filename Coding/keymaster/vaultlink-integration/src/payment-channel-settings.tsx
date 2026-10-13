import { useEffect, useState } from "react";
import type { SigningChannel } from "@vaultlink/sdk";
import { Button, Modal, TextInput } from "@keymaster/ui";
import type { PaymentChannelDTO } from "./wallet-payments.js";
import type { PaymentUIProps } from "./ui.js";

export function PaymentChannelSettings({ execute, text }: PaymentUIProps) {
  const [signing, setSigning] = useState<SigningChannel[]>([]);
  const [hardware, setHardware] = useState<boolean>();
  const [loading, setLoading] = useState(true);
  const [channels, setChannels] = useState<PaymentChannelDTO[]>([]);
  const [editing, setEditing] = useState<PaymentChannelDTO>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    setLoading(true);
    setError("");
    setHardware(undefined);
    setSigning([]);
    setChannels([]);
    // Do not expose editable policies until the actual backend is known.
    void Promise.all([
      execute({ action: "backend" }),
      execute({ action: "signing-list" }),
      execute({ action: "list" }),
    ])
      .then(([backend, signingRows, paymentRows]) => {
        if (!live) return;
        setHardware(backend === "hardware");
        setSigning(signingRows as SigningChannel[]);
        setChannels(paymentRows as PaymentChannelDTO[]);
      })
      .catch((e) => {
        if (live) setError(String(e));
      })
      .finally(() => {
        if (live) setLoading(false);
      });
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
  async function changeSigning(c: SigningChannel) {
    setBusy(true);
    setError("");
    try {
      await execute({
        action: "signing-configure",
        id: c.id,
        revision: c.revision,
        mode: c.mode === "automatic" ? "manual" : "automatic",
      });
      setSigning(
        (await execute({ action: "signing-list" })) as SigningChannel[],
      );
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section
      className="wallet-channels"
      aria-label={text("channels.title", "钱包授权渠道")}
    >
      <header className="wallet-channels__header">
        <div>
          <h2>{text("channels.title", "钱包授权渠道")}</h2>
          <p>
            {text(
              "channels.description",
              "按渠道管理签名授权和支付额度；超过免确认额度仍可手动批准。",
            )}
          </p>
        </div>
        {hardware !== undefined ? (
          <span className="wallet-channels__backend">
            {hardware
              ? text("channels.hardware", "RocKey · 只读")
              : text("channels.software", "软件钱包 · 可设置")}
          </span>
        ) : null}
      </header>
      {hardware ? (
        <p className="wallet-channels__notice">
          {text(
            "signing.hardwareLocal",
            "请在 RocKey 的渠道设置菜单修改授权和额度；此处仅展示。",
          )}
        </p>
      ) : null}
      {error ? (
        <p className="wallet-channels__error" role="alert">
          {error}
        </p>
      ) : null}
      {loading ? (
        <p className="wallet-channels__empty" role="status">
          {text("channels.loading", "正在读取渠道…")}
        </p>
      ) : (
        <>
          <div className="wallet-channels__section-title">
            <h3>{text("channels.signing", "签名授权")}</h3>
            <span>{signing.length}</span>
          </div>
          <div
            className="wallet-channels__table-wrap"
            role="region"
            aria-label={text("channels.signing", "签名授权")}
            tabIndex={0}
          >
            <table className="wallet-channels__table">
              <thead>
                <tr>
                  <th scope="col">{text("channels.channel", "渠道")}</th>
                  <th scope="col">{text("channels.owner", "来源")}</th>
                  <th scope="col">{text("channels.strategy", "授权策略")}</th>
                  <th scope="col" className="wallet-channels__action">
                    {text("channels.action", "操作")}
                  </th>
                </tr>
              </thead>
              <tbody>
                {!signing.length ? (
                  <tr>
                    <td colSpan={4} className="wallet-channels__empty">
                      {text("channels.signingEmpty", "尚无已注册的签名渠道")}
                    </td>
                  </tr>
                ) : null}
                {signing.map((c) => (
                  <tr key={c.id}>
                    <td>
                      <code>{c.id}</code>
                    </td>
                    <td>{c.owner}</td>
                    <td>
                      <span
                        className={`wallet-channels__badge${c.mode === "automatic" ? " wallet-channels__badge--auto" : ""}`}
                      >
                        {c.mode === "automatic"
                          ? text("signing.auto", "自动授权")
                          : text("signing.manual", "人工授权")}
                      </span>
                    </td>
                    <td className="wallet-channels__action">
                      {hardware === false ? (
                        <Button
                          variant="ghost"
                          disabled={busy}
                          onClick={() => void changeSigning(c)}
                        >
                          {c.mode === "automatic"
                            ? text("signing.setManual", "改为人工授权")
                            : text("signing.setAuto", "改为自动授权")}
                        </Button>
                      ) : (
                        <span className="wallet-channels__muted">
                          {text("channels.onDevice", "设备上设置")}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="wallet-channels__section-title">
            <h3>{text("payment.channels", "支付渠道")}</h3>
            <span>{channels.length}</span>
          </div>
          <p className="wallet-channels__hint">
            {text(
              "channels.sessionHint",
              "会话额度仅适用于外部 App，每次连接独立累计。金额单位：聪（sat）。",
            )}
          </p>
          <div
            className="wallet-channels__table-wrap"
            role="region"
            aria-label={text("payment.channels", "支付渠道")}
            tabIndex={0}
          >
            <table className="wallet-channels__table wallet-channels__table--payment">
              <thead>
                <tr>
                  <th scope="col">{text("channels.channel", "渠道")}</th>
                  <th scope="col">{text("channels.owner", "来源")}</th>
                  <th scope="col">{text("channels.single", "单笔免确认")}</th>
                  <th scope="col">
                    {text("channels.session", "新会话免确认总额")}
                  </th>
                  <th scope="col">{text("channels.status", "免确认")}</th>
                  <th scope="col" className="wallet-channels__action">
                    {text("channels.action", "操作")}
                  </th>
                </tr>
              </thead>
              <tbody>
                {!channels.length ? (
                  <tr>
                    <td colSpan={6} className="wallet-channels__empty">
                      {text("payment.empty", "尚无已注册的支付渠道")}
                    </td>
                  </tr>
                ) : null}
                {channels.map((c) => (
                  <tr key={c.id}>
                    <td>
                      <code>{c.id}</code>
                      <small>
                        {c.paymentType} · {c.network}
                      </small>
                    </td>
                    <td>
                      <span>{c.owner}</span>
                      <small>
                        {c.kind === "app"
                          ? text("channels.app", "外部 App")
                          : text("channels.plugin", "内部插件")}
                      </small>
                    </td>
                    <td className="wallet-channels__amount">
                      {c.singleLimit}
                      <small>sat</small>
                    </td>
                    <td className="wallet-channels__amount">
                      {c.kind === "app" ? (
                        <>
                          {c.defaultSessionLimit}
                          <small>sat</small>
                        </>
                      ) : (
                        <span className="wallet-channels__muted">—</span>
                      )}
                    </td>
                    <td>
                      <span
                        className={`wallet-channels__badge${c.enabled ? " wallet-channels__badge--auto" : ""}`}
                      >
                        {c.enabled
                          ? text("channels.enabled", "已开启")
                          : text("channels.disabled", "已关闭")}
                      </span>
                    </td>
                    <td className="wallet-channels__action">
                      {hardware === false ? (
                        <Button
                          variant="ghost"
                          disabled={busy}
                          onClick={() => setEditing({ ...c })}
                        >
                          {text("payment.edit", "修改额度")}
                        </Button>
                      ) : (
                        <span className="wallet-channels__muted">
                          {text("channels.onDevice", "设备上设置")}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
      {editing ? (
        <Modal
          open
          title={text("payment.edit", "修改额度")}
          onClose={() => {
            if (!busy) setEditing(undefined);
          }}
          footer={
            <>
              <Button
                variant="ghost"
                disabled={busy}
                onClick={() => setEditing(undefined)}
              >
                {text("payment.cancel", "取消")}
              </Button>
              <Button disabled={busy} onClick={() => void save()}>
                {text("payment.save", "保存额度")}
              </Button>
            </>
          }
        >
          <div className="wallet-channel-edit__identity">
            <strong>{editing.owner}</strong>
            <code>{editing.id}</code>
          </div>
          <p className="wallet-channel-edit__hint">
            {text(
              "channels.editHint",
              "额度以内免确认；超出额度会请求确认。新会话总额用于之后的新连接。",
            )}
          </p>
          <div className="wallet-channel-edit__fields">
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
          </div>
          <label className="wallet-channel-edit__toggle">
            <input
              type="checkbox"
              checked={editing.enabled}
              onChange={(e) =>
                setEditing({ ...editing, enabled: e.currentTarget.checked })
              }
            />
            {text("payment.enabled", "启用免确认")}
          </label>
          {error ? (
            <p className="wallet-channels__error" role="alert">
              {error}
            </p>
          ) : null}
        </Modal>
      ) : null}
    </section>
  );
}
