import type { CollectibleTransferHandler, CollectibleTransferWidgetProps } from "@keymaster/contracts";
import { useCapability, useI18n } from "@keymaster/runtime";
import { Button, TextInput } from "@keymaster/ui";
import { useEffect, useMemo, useState } from "react";
import { ORDINAL_TRANSFER_SERVICE_CAPABILITY, type OrdinalTransferService, type OrdinalTransferPreview } from "./ordinalTransferService.js";
import { ripemd160 } from "@noble/hashes/ripemd160";
import { sha256 } from "@noble/hashes/sha256";

export function createOrdinalTransferHandler(): CollectibleTransferHandler {
  return {
    id: "1satordinals.transfer",
    name: { key: "oneSat.transfer.name", fallback: "1Sat Ordinals transfer" },
    order: 10,
    supports(ref) {
      return ref.providerId === "1satordinals";
    },
    supportsRecipientPublicKeyHex(publicKeyHex: string) {
      return /^(02|03)[0-9a-f]{64}$/.test(publicKeyHex);
    },
    component: OrdinalTransferWidget
  };
}

export function OrdinalTransferWidget({ collectibleRef, detail, recipientPublicKeyHex, onCompleted }: CollectibleTransferWidgetProps) {
  const { t } = useI18n();
  const service = useCapability<OrdinalTransferService>(ORDINAL_TRANSFER_SERVICE_CAPABILITY);
  const [recipientAddress, setRecipientAddress] = useState("");
  const [feeRate, setFeeRate] = useState("1000");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<OrdinalTransferPreview | null>(null);
  const [result, setResult] = useState<string | null>(null);

  const network = detail.summary.network ?? "main";

  useEffect(() => {
    if (!recipientPublicKeyHex) return;
    setRecipientAddress(publicKeyHexToP2pkhAddress(recipientPublicKeyHex, network));
  }, [network, recipientPublicKeyHex]);

  const title = useMemo(() => detail.summary.name, [detail.summary.name]);

  async function prepare() {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const p = await service.prepare({
        collectibleId: collectibleRef.collectibleId,
        recipientAddress,
        network,
        feeRateSatoshisPerKb: Number(feeRate) || 1000
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
      const reference = r.spend.canonicalTxid ?? r.spend.txid;
      setResult(reference);
      onCompleted({
        ref: collectibleRef,
        reference,
        observedReference: r.observedReference,
        network,
        completedAt: new Date().toISOString(),
        details: { collectibleId: r.collectibleId }
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="ordinal-transfer-widget">
      <p>{typeof title === "string" ? title : title.fallback}</p>
      <TextInput label={t("oneSat.transfer.recipient", { defaultValue: "Recipient address" })} value={recipientAddress} onChange={(e) => setRecipientAddress(e.currentTarget.value)} />
      <TextInput label={t("oneSat.transfer.feeRate", { defaultValue: "Fee rate" })} value={feeRate} onChange={(e) => setFeeRate(e.currentTarget.value)} />
      {error ? <p>{error}</p> : null}
      {preview ? <pre>{preview.outputScriptHex.slice(0, 120)}…</pre> : null}
      {result ? <p>{result}</p> : null}
      <div>
        <Button onClick={() => void prepare()} disabled={busy}>{t("oneSat.transfer.prepare", { defaultValue: "Preview" })}</Button>
        <Button onClick={() => void submit()} disabled={!preview || busy}>{t("oneSat.transfer.submit", { defaultValue: "Submit" })}</Button>
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
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
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
  return "1".repeat(leadingZeros) + digits.reverse().map((d) => alphabet[d]!).join("");
}
