import { PublicKey } from "@bsv/sdk";
import { useMemo, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { Check, Copy, UserRound } from "lucide-react";
import { Button, Modal } from "@keymaster/ui";
import { usePluginI18n, useResourceView } from "@keymaster/runtime";
import { formatShortPublicKey } from "@keymaster/contracts";
import { useP2pkhResources } from "./P2pkhResourceContext.js";
function p2pkhAddress(publicKeyHex: string | undefined, network: "mainnet" | "testnet"): string | null {
  if (!publicKeyHex) return null;
  try {
    return PublicKey.fromString(publicKeyHex).toAddress(network);
  } catch {
    return null;
  }
}

async function copyText(value: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    return false;
  }
}

function CopyButton({ value }: { value: string }) {
  const { t } = usePluginI18n();
  const [copied, setCopied] = useState(false);

  async function copy() {
    if (await copyText(value)) {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    }
  }

  return (
    <Button size="sm" variant="ghost" className="home-actions__copy" onClick={() => void copy()}>
      {copied ? <Check size={15} /> : <Copy size={15} />}
      {copied ? t("p2pkh.identity.action.copied", { defaultValue: "已复制" }) : t("p2pkh.identity.action.copy", { defaultValue: "拷贝" })}
    </Button>
  );
}

function MyInfoModal({ open, onClose, publicKeyHex, hasP2pkh }: { open: boolean; onClose: () => void; publicKeyHex?: string; hasP2pkh: boolean }) {
  const { t } = usePluginI18n();
  const address = useMemo(() => p2pkhAddress(publicKeyHex, "mainnet"), [publicKeyHex]);

  return (
    <Modal open={open} onClose={onClose} title={t("p2pkh.identity.info.title", { defaultValue: "我的信息" })} closeButtonLabel={t("p2pkh.identity.info.close", { defaultValue: "关闭我的信息" })} data-testid="home-my-info-modal">
      {!publicKeyHex ? (
        <p className="home-actions__hint">{t("p2pkh.identity.info.noKey", { defaultValue: "请选择一个可用的密钥后再查看信息。" })}</p>
      ) : (
        <div className="home-actions__identity">
          <div className="home-actions__qr" aria-label={t("p2pkh.identity.info.publicKeyQr", { defaultValue: "公钥二维码" })}>
            <QRCodeSVG value={publicKeyHex} size={196} level="M" includeMargin />
          </div>
          <IdentityRow label={t("p2pkh.identity.info.publicKey", { defaultValue: "公钥" })} value={publicKeyHex} shortValue={formatShortPublicKey(publicKeyHex)} />
          {address ? <IdentityRow label={t("p2pkh.identity.info.address", { defaultValue: "地址" })} value={address} /> : null}
          {hasP2pkh ? <TestnetAddress publicKeyHex={publicKeyHex} /> : null}
        </div>
      )}
    </Modal>
  );
}

function TestnetAddress({ publicKeyHex }: { publicKeyHex: string }) {
  const { t } = usePluginI18n();
  const includeTestnet = (useResourceView<boolean>(useP2pkhResources(), "p2pkh.identity-testnet", []).data ?? false);
  const address = useMemo(() => p2pkhAddress(publicKeyHex, "testnet"), [publicKeyHex]);
  if (!includeTestnet || !address) return null;
  return <IdentityRow label={t("p2pkh.identity.info.testnetAddress", { defaultValue: "Testnet 地址" })} value={address} />;
}

function IdentityRow({ label, value, shortValue }: { label: string; value: string; shortValue?: string }) {
  return <div className="home-actions__identity-row">
    <span className="home-actions__identity-label">{label}</span>
    <code title={value}>{shortValue ?? value}</code>
    <CopyButton value={value} />
  </div>;
}

export function IdentityHomeButton() {
 const { t } = usePluginI18n();
 const [open, setOpen] = useState(false);
 const publicKeyHex = useResourceView<{ activePublicKeyHex?: string }>(useP2pkhResources(), "p2pkh.identity-key", []).data?.activePublicKeyHex;
 return <section className="home-actions"><div className="home-actions__grid">
 <button type="button" className="home-actions__shortcut" onClick={() => setOpen(true)} data-testid="home-my-info-button"><span className="home-actions__icon home-actions__icon--info"><UserRound size={28} /></span><span>{t("p2pkh.identity.action.myInfo")}</span></button>
 </div><MyInfoModal open={open} onClose={() => setOpen(false)} publicKeyHex={publicKeyHex} hasP2pkh /></section>;
}
