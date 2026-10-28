import { useP2pkhResources } from "../P2pkhResourceContext.js";
import { P2pkhTransferWidget } from "../widgets/P2pkhTransferWidget.js";
import { useMemo, useState } from "react";
import type {
  BsvNetwork,
  KeyIdentity,
  P2pkhAddressCodec,
  TransferRecipient
} from "@keymaster/contracts";
import {
  P2PKH_ADDRESS_CODEC_CAPABILITY
} from "@keymaster/contracts";
import {
  router,
  useCurrentPath,
  usePluginI18n,
  useResourceViewSelector
} from "@keymaster/runtime";
import { useOptionalPluginCapability } from "webloom-framework/react";
import { EmptyState, PageHeader, TextInput } from "@keymaster/ui";

const COMPRESSED_PUBLIC_KEY = /^(02|03)[0-9a-f]{64}$/u;

interface RecipientCandidate {
  kind: "public-key" | "address";
  publicKeyHex?: string;
  network: BsvNetwork;
  address?: string;
  recipient?: TransferRecipient;
}

interface UrlRecipientState {
  kind: "none" | "public-key" | "address" | "invalid";
  publicKeyHex?: string;
  address?: string;
  network?: BsvNetwork;
  parsedAddress?: { network: BsvNetwork; hash160Hex: string };
  error?: "invalidPublicKey" | "invalidAddress" | "networkMismatch" | "conflict";
}

interface ManualResolution {
  candidate?: RecipientCandidate;
  error?: "invalidAddress" | "networkMismatch";
  searching: false;
}

function normalizePublicKey(value: string): string | undefined {
  const normalized = value.trim().toLowerCase();
  return COMPRESSED_PUBLIC_KEY.test(normalized) ? normalized : undefined;
}

function isAddressLike(value: string): boolean {
  if (/^[123mn][A-Za-z0-9]{25,}$/u.test(value)) return true;
  return /^(bc1|tb1|bsv|tbsv)[A-Za-z0-9]{12,}$/iu.test(value);
}

function makePublicCandidate(
  publicKeyHex: string,
  network: BsvNetwork,
  codec: P2pkhAddressCodec | undefined
): RecipientCandidate {
  let address: string | undefined;
  if (codec) {
    try {
      address = codec.deriveAddress(publicKeyHex, network);
    } catch {
      address = undefined;
    }
  }
  return {
    kind: "public-key",
    publicKeyHex,
    network,
    address,
    recipient: address
      ? {
        identity: { publicKeyHex, source: "manual" },
        network,
        address,
        addressSource: "derived",
      }
      : undefined
  };
}

function makeAddressCandidate(
  address: string,
  network: BsvNetwork,
  publicKeyHex?: string
): RecipientCandidate {
  return {
    kind: "address",
    publicKeyHex: publicKeyHex,
    network,
    address,
    recipient: {
      ...(publicKeyHex ? { identity: { publicKeyHex, source: "manual" as const } } : {}),
      network,
      address,
      addressSource: "manual",
    }
  };
}

export function P2pkhTransferPage({ location }: { location: import("@keymaster/contracts").PageUiLocation }) {
  useCurrentPath();
  const { t } = usePluginI18n();
  const reader = useP2pkhResources();
  const codec = useOptionalPluginCapability(P2PKH_ADDRESS_CODEC_CAPABILITY);
  const walletContext = useResourceViewSelector<{ identity?: KeyIdentity; address?: string }, { identity?: KeyIdentity; address?: string }>(
    reader,
    "p2pkh.wallet-context",
    [],
    (snapshot) => snapshot.data ?? {}
  );
  const bsvNetwork = walletContext.identity?.bsvNetwork;
  const locationSearch = location.path.split("?", 2)[1]?.split("#", 1)[0] ?? "";
  const urlParams = useMemo(() => new URLSearchParams(locationSearch), [locationSearch]);
  const urlRecipient = useMemo<UrlRecipientState>(() => {
    if (!bsvNetwork) return { kind: "none" };
    const rawPublicKey = urlParams.get("recipientPublicKeyHex");
    const rawAddress = urlParams.get("recipientAddress");
    if (rawPublicKey === null && rawAddress === null) return { kind: "none" };

    const publicKeyHex = rawPublicKey === null ? undefined : normalizePublicKey(rawPublicKey);
    if (rawPublicKey !== null && !publicKeyHex) {
      return { kind: "invalid", error: "invalidPublicKey" };
    }

    if (rawAddress !== null) {
      const address = rawAddress.trim();
      if (!address) return { kind: "invalid", error: "invalidAddress" };
      if (!codec) {
        if (publicKeyHex) return { kind: "invalid", error: "conflict" };
        return { kind: "address", address, network: bsvNetwork };
      }
      const parsedAddress = codec.parseAddress(address);
      if (!parsedAddress) return { kind: "invalid", error: "invalidAddress" };
      if (parsedAddress.network !== bsvNetwork) {
        return { kind: "invalid", error: "networkMismatch" };
      }
      if (publicKeyHex) {
        try {
          const derivedAddress = codec.deriveAddress(publicKeyHex, parsedAddress.network);
          if (derivedAddress !== address) return { kind: "invalid", error: "conflict" };
        } catch {
          return { kind: "invalid", error: "conflict" };
        }
      }
      return { kind: "address", publicKeyHex, address, network: parsedAddress.network, parsedAddress };
    }

    return { kind: "public-key", publicKeyHex, network: bsvNetwork };
  }, [codec, bsvNetwork, urlParams]);

  const [manualInput, setManualInput] = useState("");
  const [addressCopied, setAddressCopied] = useState(false);

  const manualResolution = useMemo<ManualResolution>(() => {
    if (!bsvNetwork) return { searching: false };
    const value = manualInput.trim();
    if (!value) return { searching: false };
    const publicKeyHex = normalizePublicKey(value);
    if (publicKeyHex) {
      return { candidate: makePublicCandidate(publicKeyHex, bsvNetwork, codec), searching: false };
    }
    if (codec) {
      const parsedAddress = codec.parseAddress(value);
      if (parsedAddress) {
        if (parsedAddress.network !== bsvNetwork) return { error: "networkMismatch", searching: false };
        return { candidate: makeAddressCandidate(value, parsedAddress.network), searching: false };
      }
    }
    if (isAddressLike(value)) return { error: "invalidAddress", searching: false };
    return { searching: false };
  }, [codec, bsvNetwork, manualInput]);

  const urlCandidate = useMemo<RecipientCandidate | undefined>(() => {
    if (!bsvNetwork) return undefined;
    if (urlRecipient.kind === "public-key" && urlRecipient.publicKeyHex) {
      return makePublicCandidate(urlRecipient.publicKeyHex, bsvNetwork, codec);
    }
    if (urlRecipient.kind === "address" && urlRecipient.address && urlRecipient.network) {
      return makeAddressCandidate(urlRecipient.address, urlRecipient.network, urlRecipient.publicKeyHex);
    }
    return undefined;
  }, [codec, bsvNetwork, urlRecipient]);

  const candidate = urlRecipient.kind === "none" ? manualResolution.candidate : urlCandidate;
  const candidateError = urlRecipient.kind === "invalid" ? urlRecipient.error : manualResolution.error;

  function clearRecipient() {
    router.push("/transfer");
  }

  async function copyRecipientAddress(address: string) {
    try { await navigator.clipboard.writeText(address); setAddressCopied(true); }
    catch { setAddressCopied(false); }
  }
  function sourceLabel(candidateValue: RecipientCandidate): string {
    if (candidateValue.kind === "address") {
      return t("p2pkh.transferPage.page.recipient.source.manualAddress", { defaultValue: "手工地址" });
    }
    return t("p2pkh.transferPage.page.recipient.source.manualPublicKey", { defaultValue: "手工公钥" });
  }

  function networkLabel(network: BsvNetwork): string {
    return network === "test"
      ? t("p2pkh.transferPage.page.recipient.testnet", { defaultValue: "testnet" })
      : t("p2pkh.transferPage.page.recipient.mainnet", { defaultValue: "主网" });
  }

  if (!bsvNetwork || !walletContext.identity) {
    return (
      <div className="transfer-page">
        <PageHeader title={t("p2pkh.transferPage.route.title", { defaultValue: "转账" })} />
        <EmptyState
          title={t("p2pkh.transferPage.page.empty.noKey.title", { defaultValue: "还没有 key" })}
          description={t("p2pkh.transferPage.page.empty.noKey.desc", { defaultValue: "导入或创建一个 key 后再开始转账。" })}
        />
      </div>
    );
  }

  if (urlRecipient.kind === "invalid") {
    const errorText = urlRecipient.error === "conflict"
      ? t("p2pkh.transferPage.page.recipient.conflict", { defaultValue: "公钥与地址不一致，已阻断转账。" })
      : urlRecipient.error === "networkMismatch"
        ? t("p2pkh.transferPage.page.recipient.networkMismatch", { defaultValue: "收款地址的网络与当前身份不一致。" })
        : urlRecipient.error === "invalidPublicKey"
          ? t("p2pkh.transferPage.page.recipient.invalidPublicKey", { defaultValue: "公钥必须是压缩格式的 33 字节 hex 公钥。" })
          : t("p2pkh.transferPage.page.recipient.invalidAddress", { defaultValue: "这不是有效的 P2PKH 地址，请从对应资产入口转账。" });
    return (
      <div className="transfer-page">
        <PageHeader title={t("p2pkh.transferPage.route.title", { defaultValue: "转账" })} />
        <EmptyState title={t("p2pkh.transferPage.page.invalidRecipient", { defaultValue: "收款方参数无效。" })} description={errorText} />
        <button type="button" onClick={clearRecipient}>{t("p2pkh.transferPage.page.clearRecipient", { defaultValue: "清除收款方" })}</button>
      </div>
    );
  }

  const canMountWidget = Boolean(candidate?.recipient || candidate?.publicKeyHex || candidate?.address);

  return (
    <div className="transfer-page">
      <PageHeader
        title={t("p2pkh.transferPage.route.title", { defaultValue: "转账" })}
        description={t("p2pkh.transferPage.page.desc.default", { defaultValue: "输入收款公钥或地址，核对只读转账信息后提交。" })}
      />

      <section className="transfer-page__step-card transfer-page__recipient" aria-labelledby="transfer-recipient-title">
        <div className="transfer-page__step-heading">
          <span>1</span>
          <div>
            <h3 id="transfer-recipient-title">{t("p2pkh.transferPage.page.recipient.title", { defaultValue: "收款方" })}</h3>
            <p>{t("p2pkh.transferPage.page.recipient.hint", { defaultValue: "粘贴压缩公钥或 P2PKH 地址。" })}</p>
          </div>
        </div>

        {urlRecipient.kind !== "none" && candidate ? (
          <div className="transfer-page__recipient-summary" data-testid="recipient-target" data-recipient-public-key-hex={candidate.publicKeyHex}>
            {candidate.publicKeyHex ? (
              <div>
                <span>{t("p2pkh.transferPage.page.recipient.publicKey", { defaultValue: "收款人公钥" })}</span>
                <code>{candidate.publicKeyHex}</code>
              </div>
            ) : null}
            <div>
              <span>{t("p2pkh.transferPage.page.recipient.network", { defaultValue: "网络" })}</span>
              <span>{networkLabel(candidate.network)}</span>
            </div>
            <div>
              <span>{t("p2pkh.transferPage.page.recipient.address", { defaultValue: "收款地址" })}</span>
              {candidate.address ? (
                <>
                  <code data-testid="recipient-address">{candidate.address}</code>
                  <button type="button" onClick={() => void copyRecipientAddress(candidate.address!)}>{addressCopied ? t("p2pkh.transferPage.page.recipient.copied", { defaultValue: "已复制" }) : t("p2pkh.transferPage.page.recipient.copy", { defaultValue: "复制地址" })}</button>
                </>
              ) : <span>{t("p2pkh.transferPage.page.recipient.noCodec", { defaultValue: "P2PKH 地址能力不可用，地址反查已关闭。" })}</span>}
            </div>
            <span className={`transfer-page__recipient-source is-${candidate.kind}`} data-testid="recipient-source">{sourceLabel(candidate)}</span>
            <button type="button" onClick={clearRecipient}>{t("p2pkh.transferPage.page.recipient.change", { defaultValue: "更换收款方" })}</button>
          </div>
        ) : (
          <>
            <TextInput
              label={t("p2pkh.transferPage.page.recipient.address", { defaultValue: "收款地址" })}
              placeholder={t("p2pkh.transferPage.page.recipient.inputPlaceholder", { defaultValue: "粘贴公钥或地址" })}
              value={manualInput}
              onChange={(event) => { setManualInput(event.currentTarget.value); }}
            />
          </>
        )}

        {candidateError ? (
          <p className="transfer-page__error">
            {candidateError === "networkMismatch"
              ? t("p2pkh.transferPage.page.recipient.networkMismatch", { defaultValue: "收款地址的网络与当前身份不一致。" })
              : t("p2pkh.transferPage.page.recipient.invalidAddress", { defaultValue: "这不是有效的 P2PKH 地址，请从对应资产入口转账。" })}
          </p>
        ) : null}

        {urlRecipient.kind === "none" && candidate ? (
          <div className="transfer-page__recipient-summary" data-testid="recipient-preview">
            {candidate.publicKeyHex ? <code>{candidate.publicKeyHex}</code> : null}
            <div><span>{t("p2pkh.transferPage.page.recipient.network", { defaultValue: "网络" })}</span><span>{networkLabel(candidate.network)}</span></div>
            {candidate.address ? <code data-testid="recipient-address">{candidate.address}</code> : <span>{t("p2pkh.transferPage.page.recipient.noCodec", { defaultValue: "P2PKH 地址能力不可用，地址反查已关闭。" })}</span>}
            <span className={`transfer-page__recipient-source is-${candidate.kind}`} data-testid="recipient-source">{sourceLabel(candidate)}</span>
            {candidate.address ? (
              <button type="button" onClick={() => void copyRecipientAddress(candidate.address!)}>{addressCopied ? t("p2pkh.transferPage.page.recipient.copied", { defaultValue: "已复制" }) : t("p2pkh.transferPage.page.recipient.copy", { defaultValue: "复制地址" })}</button>
            ) : null}
          </div>
        ) : null}
        {candidate?.kind === "address" ? (
          <label>
            {t("p2pkh.transferPage.page.recipient.network", { defaultValue: "网络" })}
            <select aria-label={t("p2pkh.transferPage.page.recipient.network", { defaultValue: "网络" })} value={candidate.network} disabled onChange={() => undefined}>
              <option value="main">{networkLabel("main")}</option>
              <option value="test">{networkLabel("test")}</option>
            </select>
          </label>
        ) : null}
      </section>

      {candidate && !candidateError && !canMountWidget ? (
        <p className="transfer-page__error">{t("p2pkh.transferPage.page.recipient.noCodec", { defaultValue: "P2PKH 地址能力不可用，地址反查已关闭。" })}</p>
      ) : null}

      {candidate && !candidateError && canMountWidget ? (
        <section className="transfer-page__provider-widget" data-testid="p2pkh-transfer-widget">
          <P2pkhTransferWidget
            key={location.path}
            initialAmountSatoshis={paymentAmountSatoshis(urlParams.get("requestedAmountBsv"))}
            recipientAddress={candidate.address}
            recipientPublicKeyHex={candidate.publicKeyHex}
            onCompleted={() => router.push("/transfer")}
          />
        </section>
      ) : null}
    </div>
  );
}

/** 金额是预填提示；最终校验、签名及广播仍由 P2PKH Widget 执行。 */
export function paymentAmountSatoshis(value: string | null): string | undefined {
 if (!value || !/^(?:0|[1-9][0-9]{0,7})(?:\.[0-9]{1,8})?$/.test(value)) return undefined;
 const [whole, fraction = ""] = value.split(".");
 const sats = BigInt(whole!) * 100000000n + BigInt(fraction.padEnd(8, "0"));
 return sats > 0n && sats <= 2100000000000000n ? sats.toString() : undefined;
}
