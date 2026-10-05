import { useP2pkhResources } from "../P2pkhResourceContext.js";
import { P2pkhTransferWidget } from "../widgets/P2pkhTransferWidget.js";
import { useEffect, useMemo, useState } from "react";
import type {
  VaultLifecycleSnapshot,
  BsvNetwork,
  Contact,
  P2pkhAddressCodec,
  TransferOffer,
  TransferRecipient
} from "@keymaster/contracts";
import {
  CONTACTS_PICKER_CAPABILITY,
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

/** P2PKH 设置资源的最小页面投影。字段含义：是否把 testnet 纳入转账范围。 */
interface TransferNetworkSettings {
  /** 是否启用 testnet；关闭时页面只允许主网。 */
  includeTestnet?: boolean;
}

interface RecipientCandidate {
  /** 输入形态：公钥或地址。 */
  kind: "public-key" | "address";
  /** 公钥候选的输入来源；手工粘贴即使命中联系人，也仍保留手工来源。 */
  publicKeySource?: "contact" | "manual";
  /** 可选的收款人公钥；地址未命中联系人时没有该字段。 */
  publicKeyHex?: string;
  /** 地址所属网络。 */
  network: BsvNetwork;
  /** 解析后的收款地址；地址是支付真值。 */
  address?: string;
  /** 联系人昵称；命中时回填。 */
  contactName?: string;
  /** 可直接传给 P2PKH Widget 的完整状态。 */
  recipient?: TransferRecipient;
}

interface UrlRecipientState {
  /** URL 收款参数状态。 */
  kind: "none" | "public-key" | "address" | "invalid";
  /** URL 中的压缩公钥。 */
  publicKeyHex?: string;
  /** URL 中的地址。 */
  address?: string;
  /** URL 参数或地址解析出的网络。 */
  network?: BsvNetwork;
  /** 地址解析结果，用于公钥与地址的一致性核对。 */
  parsedAddress?: { network: BsvNetwork; hash160Hex: string };
  /** 阻断页面时向用户展示的原因。 */
  error?: "invalidPublicKey" | "invalidAddress" | "testnetDisabled" | "conflict";
}

interface ManualResolution {
  /** 手工输入解析出的收款方候选。 */
  candidate?: RecipientCandidate;
  /** 需要阻断继续操作的错误文案 key。 */
  error?: "invalidAddress" | "testnetDisabled";
  /** 是否应继续作为通讯录搜索文本处理。 */
  searching: boolean;
}

function normalizePublicKey(value: string): string | undefined {
  const normalized = value.trim().toLowerCase();
  return COMPRESSED_PUBLIC_KEY.test(normalized) ? normalized : undefined;
}

function networkFromParam(value: string | null): BsvNetwork {
  return value === "test" || value === "testnet" ? "test" : "main";
}

function isAddressLike(value: string): boolean {
  // 普通昵称通常较短；以 Base58Check 常见 version 开头且达到地址长度时，
  // 直接按地址校验，避免把错误地址悄悄当成通讯录搜索文本。
  if (/^[123mn][A-Za-z0-9]{25,}$/u.test(value)) return true;
  // 为未来地址族保留明确拒绝入口（当前不解析 bech32）。
  return /^(bc1|tb1|bsv|tbsv)[A-Za-z0-9]{12,}$/iu.test(value);
}

function contactByPublicKey(contacts: Contact[], publicKeyHex: string): Contact | undefined {
  return contacts.find((contact) => contact.publicKeyHex.trim().toLowerCase() === publicKeyHex);
}

function contactByAddress(
  contacts: Contact[],
  address: string,
  network: BsvNetwork,
  parsedAddress: { network: BsvNetwork; hash160Hex: string } | undefined,
  codec: P2pkhAddressCodec | undefined
): Contact | undefined {
  if (!codec || !parsedAddress) return undefined;
  return contacts.find((contact) => {
    try {
      const derived = codec.deriveAddress(contact.publicKeyHex.trim().toLowerCase(), network);
      const parsedDerived = codec.parseAddress(derived);
      return parsedDerived?.network === parsedAddress.network
        && parsedDerived.hash160Hex === parsedAddress.hash160Hex
        && address.length > 0;
    } catch {
      return false;
    }
  });
}

function makePublicCandidate(
  publicKeyHex: string,
  network: BsvNetwork,
  contacts: Contact[],
  codec: P2pkhAddressCodec | undefined,
  publicKeySource?: "contact" | "manual"
): RecipientCandidate {
  const contact = contactByPublicKey(contacts, publicKeyHex);
  const resolvedSource = publicKeySource ?? (contact ? "contact" : "manual");
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
    publicKeySource: resolvedSource,
    publicKeyHex,
    network,
    address,
    contactName: contact?.name,
    recipient: address
      ? {
        identity: {
            publicKeyHex,
            source: resolvedSource
          },
          network,
          address,
          addressSource: "derived",
          ...(contact?.name ? { contactName: contact.name } : {})
        }
      : undefined
  };
}

function makeAddressCandidate(
  address: string,
  network: BsvNetwork,
  parsedAddress: { network: BsvNetwork; hash160Hex: string } | undefined,
  contacts: Contact[],
  codec: P2pkhAddressCodec | undefined,
  publicKeyHex?: string
): RecipientCandidate {
  const contact = contactByAddress(contacts, address, network, parsedAddress, codec);
  const identityPublicKeyHex = publicKeyHex ?? contact?.publicKeyHex.trim().toLowerCase();
  const identitySource = contact ? "resolved" : publicKeyHex ? "manual" : undefined;
  return {
    kind: "address",
    publicKeyHex: identityPublicKeyHex,
    network,
    address,
    contactName: contact?.name,
    recipient: {
      ...(identityPublicKeyHex && identitySource
        ? { identity: { publicKeyHex: identityPublicKeyHex, source: identitySource } }
        : {}),
      network,
      address,
      addressSource: "manual",
      ...(contact?.name ? { contactName: contact.name } : {})
    }
  };
}

function offerNetwork(offer: TransferOffer): BsvNetwork | undefined {
  if (offer.network) return offer.network;
  if (offer.assetId === "bsv") return "main";
  if (offer.assetId === "bsvtest") return "test";
  return undefined;
}

export function P2pkhTransferPage({ location }: { location: import("@keymaster/contracts").PageUiLocation }) {
  // 订阅完整 location，保证联系人动作修改 query 后页面重新解析 URL。
  useCurrentPath();
  const { t } = usePluginI18n();
  const reader = useP2pkhResources();
  const ContactPicker = useOptionalPluginCapability(CONTACTS_PICKER_CAPABILITY);
  const codec = useOptionalPluginCapability(P2PKH_ADDRESS_CODEC_CAPABILITY);
  const offers = useResourceViewSelector<TransferOffer[], TransferOffer[]>(
    reader,
    "p2pkh.transfer-offers",
    [],
    (snapshot) => snapshot.data ?? []
  );
  const activeState = useResourceViewSelector<VaultLifecycleSnapshot, VaultLifecycleSnapshot>(
    reader,
    "p2pkh.transfer-active",
    [],
    (snapshot) => snapshot.data ?? { status: "booting", sessionEpoch: "boot", runGeneration: "boot", vaultLifecycleRevision: 0 }
  );
  const includeTestnet = useResourceViewSelector<TransferNetworkSettings, boolean>(
    reader,
    "p2pkh.settings",
    [],
    (snapshot) => snapshot.data?.includeTestnet === true
  );
  const contacts = useResourceViewSelector<Contact[], Contact[]>(
    reader,
    "p2pkh.transfer-contacts",
    [],
    (snapshot) => snapshot.data ?? []
  );
  const locationSearch = location.path.split("?", 2)[1]?.split("#", 1)[0] ?? "";
  const urlParams = useMemo(() => new URLSearchParams(locationSearch), [locationSearch]);
  const urlRecipient = useMemo<UrlRecipientState>(() => {
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
        // 没有 codec 时无法证明“身份 + 地址”一致；存在两者时必须阻断，
        // 单独地址则保留手工地址降级路径，由 P2PKH service 做最终校验。
        if (publicKeyHex) return { kind: "invalid", error: "conflict" };
        return {
          kind: "address",
          address,
          network: includeTestnet && networkFromParam(urlParams.get("network")) === "test" ? "test" : "main"
        };
      }
      const parsedAddress = codec.parseAddress(address);
      if (!parsedAddress) return { kind: "invalid", error: "invalidAddress" };
      if (parsedAddress.network === "test" && !includeTestnet) {
        return { kind: "invalid", error: "testnetDisabled" };
      }
      if (publicKeyHex) {
        try {
          const derivedAddress = codec.deriveAddress(publicKeyHex, parsedAddress.network);
          if (derivedAddress !== address) return { kind: "invalid", error: "conflict" };
        } catch {
          return { kind: "invalid", error: "conflict" };
        }
      }
      return {
        kind: "address",
        publicKeyHex,
        address,
        network: parsedAddress.network,
        parsedAddress
      };
    }

    const requestedNetwork = networkFromParam(urlParams.get("network"));
    return {
      kind: "public-key",
      publicKeyHex,
      network: includeTestnet && requestedNetwork === "test" ? "test" : "main"
    };
  }, [codec, includeTestnet, urlParams]);

  const [inputMode, setInputMode] = useState<"contacts" | "manual">("contacts");
  const [manualInput, setManualInput] = useState("");
  const [publicNetwork, setPublicNetwork] = useState<BsvNetwork>(urlRecipient.network ?? "main");
  const [networkChanged, setNetworkChanged] = useState(false);
  const [addressCopied, setAddressCopied] = useState(false);

  useEffect(() => {
    if (urlRecipient.kind === "none") {
      setInputMode("contacts");
      setManualInput("");
      setPublicNetwork("main");
      setNetworkChanged(false);
      setAddressCopied(false);
      return;
    }
    setInputMode("manual");
    setManualInput("");
    setPublicNetwork(urlRecipient.network ?? "main");
    setNetworkChanged(false);
    setAddressCopied(false);
  }, [locationSearch, urlRecipient.kind, urlRecipient.network]);

  const manualResolution = useMemo<ManualResolution>(() => {
    const value = manualInput.trim();
    if (!value) return { searching: false };
    const publicKeyHex = normalizePublicKey(value);
    if (publicKeyHex) {
      return { candidate: makePublicCandidate(publicKeyHex, includeTestnet ? publicNetwork : "main", contacts, codec, "manual"), searching: false };
    }
    if (codec) {
      const parsedAddress = codec.parseAddress(value);
      if (parsedAddress) {
        if (parsedAddress.network === "test" && !includeTestnet) return { error: "testnetDisabled", searching: false };
        return {
          candidate: makeAddressCandidate(value, parsedAddress.network, parsedAddress, contacts, codec),
          searching: false
        };
      }
    }
    if (isAddressLike(value)) return { error: "invalidAddress", searching: false };
    return { searching: true };
  }, [codec, contacts, includeTestnet, manualInput, publicNetwork]);

  const urlCandidate = useMemo<RecipientCandidate | undefined>(() => {
    if (urlRecipient.kind === "public-key" && urlRecipient.publicKeyHex) {
      return makePublicCandidate(urlRecipient.publicKeyHex, includeTestnet ? publicNetwork : "main", contacts, codec);
    }
    if (urlRecipient.kind === "address" && urlRecipient.address && urlRecipient.network) {
      return makeAddressCandidate(urlRecipient.address, urlRecipient.network, urlRecipient.parsedAddress, contacts, codec, urlRecipient.publicKeyHex);
    }
    return undefined;
  }, [codec, contacts, includeTestnet, publicNetwork, urlRecipient]);

  const candidate = urlRecipient.kind === "none" ? manualResolution.candidate : urlCandidate;
  const candidateError = urlRecipient.kind === "invalid" ? urlRecipient.error : manualResolution.error;
  const p2pkhOffers = useMemo(() => offers.filter((offer) => {
    if (offer.providerId !== "p2pkh") return false;
    if (offer.assetId !== "bsv" && offer.assetId !== "bsvtest") return false;
    return includeTestnet || offerNetwork(offer) !== "test";
  }), [includeTestnet, offers]);
  const selectedOffer = useMemo(() => {
    if (!candidate) return undefined;
    return p2pkhOffers.find((offer) => offerNetwork(offer) === candidate.network);
  }, [candidate, p2pkhOffers]);
  const contactMatches = useMemo(() => {
    const search = manualInput.trim().toLowerCase();
    if (!search || !manualResolution.searching) return [];
    return contacts.filter((contact) => contact.name.toLowerCase().includes(search) || contact.publicKeyHex.toLowerCase().includes(search)).slice(0, 8);
  }, [contacts, manualInput, manualResolution.searching]);

  function selectRecipient(publicKeyHex: string) {
    const canonical = normalizePublicKey(publicKeyHex);
    if (!canonical) return;
    router.push(`/transfer?recipientPublicKeyHex=${encodeURIComponent(canonical)}`);
  }

  function clearRecipient() {
    router.push("/transfer");
  }

  function changePublicNetwork(network: BsvNetwork) {
    setPublicNetwork(network);
    setNetworkChanged(true);
    setAddressCopied(false);
  }

  async function copyRecipientAddress(address: string) {
    try {
      await navigator.clipboard.writeText(address);
      setAddressCopied(true);
    } catch {
      setAddressCopied(false);
    }
  }

  function sourceLabel(candidateValue: RecipientCandidate): string {
    if (candidateValue.kind === "address") {
      return candidateValue.contactName
        ? t("p2pkh.transferPage.page.recipient.source.resolved", { defaultValue: "地址命中联系人" })
        : t("p2pkh.transferPage.page.recipient.source.manualAddress", { defaultValue: "手工地址" });
    }
    return candidateValue.publicKeySource === "contact"
      ? t("p2pkh.transferPage.page.recipient.source.contact", { defaultValue: "联系人公钥派生" })
      : t("p2pkh.transferPage.page.recipient.source.manualPublicKey", { defaultValue: "手工公钥" });
  }

  function networkLabel(network: BsvNetwork): string {
    return network === "test"
      ? t("p2pkh.transferPage.page.recipient.testnet", { defaultValue: "testnet" })
      : t("p2pkh.transferPage.page.recipient.mainnet", { defaultValue: "主网" });
  }

  if (!activeState.activePublicKeyHex) {
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
      : urlRecipient.error === "testnetDisabled"
        ? t("p2pkh.transferPage.page.recipient.testnetDisabled", { defaultValue: "未启用 testnet，请在设置中开启。" })
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

  const showPublicNetworkSelector = includeTestnet && candidate?.kind !== "address";
  const canMountWidget = Boolean(candidate?.recipient || candidate?.publicKeyHex || candidate?.address);

  return (
    <div className="transfer-page">
      <PageHeader
        title={t("p2pkh.transferPage.route.title", { defaultValue: "转账" })}
        description={t("p2pkh.transferPage.page.desc.default", { defaultValue: "选择收款地址，填写金额与矿工费率，再核对只读转账信息后提交。" })}
      />

      <section className="transfer-page__step-card transfer-page__recipient" aria-labelledby="transfer-recipient-title">
        <div className="transfer-page__step-heading">
          <span>1</span>
          <div>
            <h3 id="transfer-recipient-title">{t("p2pkh.transferPage.page.recipient.title", { defaultValue: "收款方" })}</h3>
            <p>{t("p2pkh.transferPage.page.recipient.hint", { defaultValue: "搜索联系人，或粘贴压缩公钥、P2PKH 地址。" })}</p>
          </div>
        </div>

        {urlRecipient.kind !== "none" && candidate ? (
          <div className="transfer-page__recipient-summary" data-testid="recipient-target" data-recipient-public-key-hex={candidate.publicKeyHex}>
            {candidate.contactName ? <strong>{candidate.contactName}</strong> : null}
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
            {candidate.kind === "address" && !candidate.contactName ? <span className="transfer-page__recipient-warning">{t("p2pkh.transferPage.page.recipient.unknownAddress", { defaultValue: "陌生地址" })}</span> : null}
            {candidate.kind === "public-key" && includeTestnet ? (
              <label>
                {t("p2pkh.transferPage.page.recipient.network", { defaultValue: "网络" })}
                <select aria-label={t("p2pkh.transferPage.page.recipient.network", { defaultValue: "网络" })} value={candidate.network} onChange={(event) => changePublicNetwork(event.currentTarget.value as BsvNetwork)}>
                  <option value="main">{networkLabel("main")}</option>
                  <option value="test">{networkLabel("test")}</option>
                </select>
              </label>
            ) : null}
            {networkChanged ? <p>{t("p2pkh.transferPage.page.recipient.networkChanged", { defaultValue: "地址已更新，请重新核对。" })}</p> : null}
            <button type="button" onClick={clearRecipient}>{t("p2pkh.transferPage.page.recipient.change", { defaultValue: "更换收款方" })}</button>
          </div>
        ) : (
          <>
            <div className="transfer-page__recipient-mode" role="tablist" aria-label={t("p2pkh.transferPage.page.recipient.title", { defaultValue: "收款方" })}>
              <button type="button" role="tab" aria-selected={inputMode === "contacts"} onClick={() => setInputMode("contacts")}>
                {t("p2pkh.transferPage.page.recipient.contacts", { defaultValue: "从通讯录选择" })}
              </button>
              <button type="button" role="tab" aria-selected={inputMode === "manual"} onClick={() => setInputMode("manual")}>
                {t("p2pkh.transferPage.page.recipient.manual", { defaultValue: "手工输入" })}
              </button>
            </div>
            {inputMode === "contacts" && ContactPicker ? (
              <ContactPicker
                value=""
                onChange={selectRecipient}
                placeholder={t("p2pkh.transferPage.page.recipient.placeholder", { defaultValue: "选择联系人" })}
              />
            ) : null}
            {inputMode === "contacts" && !ContactPicker ? (
              <p>{t("p2pkh.transferPage.page.recipient.searchHint", { defaultValue: "其他文本会在本地通讯录中搜索。" })}</p>
            ) : null}
            {inputMode === "manual" ? (
              <TextInput
                label={t("p2pkh.transferPage.page.recipient.address", { defaultValue: "收款地址" })}
                placeholder={t("p2pkh.transferPage.page.recipient.inputPlaceholder", { defaultValue: "粘贴公钥、地址，或搜索联系人" })}
                value={manualInput}
                onChange={(event) => { setManualInput(event.currentTarget.value); setNetworkChanged(false); }}
              />
            ) : null}
            {showPublicNetworkSelector ? (
              <label>
                {t("p2pkh.transferPage.page.recipient.network", { defaultValue: "网络" })}
                <select aria-label={t("p2pkh.transferPage.page.recipient.network", { defaultValue: "网络" })} value={publicNetwork} onChange={(event) => changePublicNetwork(event.currentTarget.value as BsvNetwork)}>
                  <option value="main">{networkLabel("main")}</option>
                  <option value="test">{networkLabel("test")}</option>
                </select>
              </label>
            ) : null}
            {manualResolution.searching ? (
              <div className="transfer-page__contact-search" data-testid="contact-search-results">
                {contactMatches.length > 0 ? contactMatches.map((contact) => (
                  <button key={contact.publicKeyHex} type="button" onClick={() => selectRecipient(contact.publicKeyHex)}>
                    {contact.name} <code>{contact.publicKeyHex}</code>
                  </button>
                )) : <p>{t("p2pkh.transferPage.page.recipient.searchEmpty", { defaultValue: "没有匹配的本地联系人。" })}</p>}
              </div>
            ) : null}
          </>
        )}

        {candidateError ? (
          <p className="transfer-page__error">
            {candidateError === "testnetDisabled"
              ? t("p2pkh.transferPage.page.recipient.testnetDisabled", { defaultValue: "未启用 testnet，请在设置中开启。" })
              : t("p2pkh.transferPage.page.recipient.invalidAddress", { defaultValue: "这不是有效的 P2PKH 地址，请从对应资产入口转账。" })}
          </p>
        ) : null}

        {urlRecipient.kind === "none" && candidate ? (
          <div className="transfer-page__recipient-summary" data-testid="recipient-preview">
            {candidate.contactName ? <strong>{candidate.contactName}</strong> : null}
            {candidate.publicKeyHex ? <code>{candidate.publicKeyHex}</code> : null}
            <div><span>{t("p2pkh.transferPage.page.recipient.network", { defaultValue: "网络" })}</span><span>{networkLabel(candidate.network)}</span></div>
            {candidate.address ? <code data-testid="recipient-address">{candidate.address}</code> : <span>{t("p2pkh.transferPage.page.recipient.noCodec", { defaultValue: "P2PKH 地址能力不可用，地址反查已关闭。" })}</span>}
            <span className={`transfer-page__recipient-source is-${candidate.kind}`} data-testid="recipient-source">{sourceLabel(candidate)}</span>
            {candidate.kind === "address" && !candidate.contactName ? <span className="transfer-page__recipient-warning">{t("p2pkh.transferPage.page.recipient.unknownAddress", { defaultValue: "陌生地址" })}</span> : null}
            {candidate.address ? (
              <button type="button" onClick={() => void copyRecipientAddress(candidate.address!)}>{addressCopied ? t("p2pkh.transferPage.page.recipient.copied", { defaultValue: "已复制" }) : t("p2pkh.transferPage.page.recipient.copy", { defaultValue: "复制地址" })}</button>
            ) : null}
            {networkChanged ? <p>{t("p2pkh.transferPage.page.recipient.networkChanged", { defaultValue: "地址已更新，请重新核对。" })}</p> : null}
          </div>
        ) : null}
        {includeTestnet && candidate?.kind === "address" ? (
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

      {candidate && !candidateError && canMountWidget && !selectedOffer ? (
        <EmptyState title={t("p2pkh.transferPage.page.noRecipientProvider", { defaultValue: "当前网络没有可用的普通 BSV 转账。" })} />
      ) : null}

      {candidate && !candidateError && canMountWidget && selectedOffer ? (
        <section className="transfer-page__provider-widget" data-testid="p2pkh-transfer-widget">
          <P2pkhTransferWidget
            key={location.path}
            initialAmountSatoshis={paymentAmountSatoshis(urlParams.get("requestedAmountBsv"))}
            offer={selectedOffer}
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
