import type { TokenRegistry, TransferOffer, TransferOfferStatus, TransferProvider } from "@keymaster/contracts";
import { useCapability, useI18n } from "@keymaster/runtime";
import { Button, EmptyState, Select, TextInput } from "@keymaster/ui";
import { ripemd160 } from "@noble/hashes/ripemd160";
import { sha256 } from "@noble/hashes/sha256";
import { useEffect, useMemo, useState } from "react";
import type { P2pkhServiceForBsv21 } from "./bsv21Service.js";
import type { Bsv21TransferService } from "./bsv21TransferService.js";
import { BSV21_TRANSFER_SERVICE_CAPABILITY } from "./bsv21TransferService.js";

export function createBsv21TransferProvider(input: { tokenRegistry: TokenRegistry; p2pkh: P2pkhServiceForBsv21 }): TransferProvider {
  return {
    id: "bsv21",
    name: { key: "bsv21.provider.name", fallback: "BSV-21" },
    order: 20,
    component: Bsv21TransferWidget,
    supportsRecipientPublicKeyHex(publicKeyHex: string) {
      return /^(02|03)[0-9a-f]{64}$/.test(publicKeyHex);
    },
    async listOffers() {
      const provider = input.tokenRegistry.get("bsv21");
      const tokens = provider ? await provider.listTokens() : [];
      if (tokens.length === 0) return [];
      const groups = new Map<"main" | "test", number>();
      for (const token of tokens) {
        const network = token.network === "test" ? "test" : "main";
        groups.set(network, (groups.get(network) ?? 0) + (token.balance?.amount ?? 0));
      }
      const out: TransferOffer[] = [];
      for (const [network, total] of groups) {
        out.push({
          id: `bsv21.${network}`,
          providerId: "bsv21",
          assetProviderId: "bsv21",
          assetId: `bsv21.${network}`,
          label: { key: "bsv21.provider.name", fallback: "BSV-21" },
          description: {
            key: "bsv21.transfer.description",
            fallback: `Transfer BSV-21 tokens on ${network === "main" ? "mainnet" : "testnet"}.`
          },
          balance: { amount: total, unit: "TOK", display: `${total} TOK` },
          status: "ready" as TransferOfferStatus,
          network,
          recipientTargetSection: network === "main" ? "mainnet" : "testnet",
          order: network === "main" ? 20 : 21
        });
      }
      out.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
      return out;
    },
    onChange(handler) {
      return input.tokenRegistry.get("bsv21")?.onChange(handler) ?? (() => undefined);
    }
  };
}

interface FormState {
  tokenId: string;
  recipientAddress: string;
  amount: string;
  feeRate: string;
}

function Bsv21TransferWidget({ offer, onCompleted, recipientPublicKeyHex }: import("@keymaster/contracts").TransferWidgetProps) {
  const { t } = useI18n();
  const service = useCapability<Bsv21TransferService>(BSV21_TRANSFER_SERVICE_CAPABILITY);
  const registry = useCapability<TokenRegistry>("token.registry");
  const [tokens, setTokens] = useState<Array<{ tokenId: string; label: string; balance: string }>>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Awaited<ReturnType<Bsv21TransferService["submit"]>> | null>(null);
  const [preview, setPreview] = useState<Awaited<ReturnType<Bsv21TransferService["prepare"]>> | null>(null);
  const [form, setForm] = useState<FormState>({
    tokenId: "",
    recipientAddress: "",
    amount: "1",
    feeRate: "1000"
  });

  useEffect(() => {
    void (async () => {
      const provider = registry.get("bsv21");
      const list = provider ? (await provider.listTokens()).filter((token) => token.network === (offer.network ?? token.network)) : [];
      setTokens(list.map((t) => ({
        tokenId: t.tokenId,
        label: typeof t.label === "string" ? t.label : t.label.fallback,
        balance: t.balance?.display ?? `${t.balance?.amount ?? 0} ${t.balance?.unit ?? "TOK"}`
      })));
      if (list[0]) {
        setForm((s) => ({ ...s, tokenId: s.tokenId || list[0]!.tokenId }));
      }
    })();
  }, [offer.network, registry]);

  useEffect(() => {
    if (!recipientPublicKeyHex) return;
    setForm((s) => ({ ...s, recipientAddress: publicKeyHexToP2pkhAddress(recipientPublicKeyHex, offer.network ?? "main") }));
  }, [offer.network, recipientPublicKeyHex]);

  const tokenOptions = useMemo(() => tokens.map((t) => ({ label: `${t.label} (${t.balance})`, value: t.tokenId })), [tokens]);

  async function prepare() {
    setBusy(true);
    setError(null);
    try {
      const p = await service.prepare({
        tokenId: form.tokenId,
        recipientAddress: form.recipientAddress,
        amount: form.amount,
        network: offer.network ?? "main",
        feeRateSatoshisPerKb: Number(form.feeRate) || 1000
      });
      setPreview(p);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function submit() {
    if (!preview) return;
    setBusy(true);
    setError(null);
    try {
      const r = await service.submit(preview);
      setResult(r);
      onCompleted({
        offerId: offer.id,
        providerId: offer.providerId,
        assetProviderId: offer.assetProviderId,
        assetId: offer.assetId,
        reference: r.spend.txid,
        completedAt: new Date().toISOString(),
        details: { tokenId: r.tokenId }
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  if (tokens.length === 0) {
    return <EmptyState title={t("bsv21.transfer.empty.title", { defaultValue: "No BSV-21 tokens yet" })} description={t("bsv21.transfer.empty.desc", { defaultValue: "Mint or sync tokens first." })} />;
  }

  return (
    <div className="bsv21-transfer-widget">
      <Select label={t("bsv21.transfer.form.token", { defaultValue: "Token" })} options={tokenOptions} value={form.tokenId} onChange={(e) => setForm((s) => ({ ...s, tokenId: e.currentTarget.value }))} />
      <TextInput label={t("bsv21.transfer.form.recipient", { defaultValue: "Recipient address" })} value={form.recipientAddress} onChange={(e) => setForm((s) => ({ ...s, recipientAddress: e.currentTarget.value }))} />
      <TextInput label={t("bsv21.transfer.form.amount", { defaultValue: "Amount" })} value={form.amount} onChange={(e) => setForm((s) => ({ ...s, amount: e.currentTarget.value }))} />
      <TextInput label={t("bsv21.transfer.form.feeRate", { defaultValue: "Fee rate" })} value={form.feeRate} onChange={(e) => setForm((s) => ({ ...s, feeRate: e.currentTarget.value }))} />
      {error ? <p>{error}</p> : null}
      {preview ? <pre>{preview.spend.rawTxHex.slice(0, 120)}…</pre> : null}
      {result ? <p>{result.spend.status}</p> : null}
      <div>
        <Button onClick={() => void prepare()} disabled={busy}>{t("bsv21.transfer.form.prepare", { defaultValue: "Preview" })}</Button>
        <Button onClick={() => void submit()} disabled={!preview || busy}>{t("bsv21.transfer.form.submit", { defaultValue: "Submit" })}</Button>
      </div>
    </div>
  );
}

function publicKeyHexToP2pkhAddress(publicKeyHex: string, network: "main" | "test" = "main"): string {
  const pub = hexToBytes(publicKeyHex);
  if (pub.length !== 33) throw new Error("Public key must be 33 bytes (compressed)");
  const sha = sha256(pub);
  const ripe = ripemd160(sha);
  const versionByte = network === "main" ? 0x00 : 0x6f;
  const payload = concatBytes(new Uint8Array([versionByte]), ripe);
  const checksum = sha256(sha256(payload)).slice(0, 4);
  return base58Encode(concatBytes(payload, checksum));
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.replace(/^0x/, "");
  if (clean.length % 2 !== 0) throw new Error("Invalid hex length");
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function concatBytes(...chunks: Uint8Array[]): Uint8Array {
  const length = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

function base58Encode(bytes: Uint8Array): string {
  if (bytes.length === 0) return "";
  const digits = [0];
  for (const byte of bytes) {
    let carry = byte;
    for (let i = 0; i < digits.length; i++) {
      const v = digits[i]! * 256 + carry;
      digits[i] = v % 58;
      carry = (v / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  let leadingZeros = 0;
  for (const byte of bytes) {
    if (byte === 0) leadingZeros++;
    else break;
  }
  return "1".repeat(leadingZeros) + digits.reverse().map((d) => BASE58_ALPHABET[d]!).join("");
}

const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
