import { PublicKey } from "@bsv/sdk";
import { BrowserQRCodeReader } from "@zxing/browser";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { Camera, Check, Copy, Image, ScanLine, UserRound, UserPlus } from "lucide-react";
import { Button, Modal, TextInput } from "@keymaster/ui";
import { useCapability, useHasCapability, useI18n, usePluginHost, useRegistry, useResourceSelector } from "@keymaster/runtime";
import {
  CONTACT_PUBLIC_KEY_ACTION_REGISTRY_CAPABILITY,
  formatShortPublicKey,
  type Contact,
  type ContactPublicKeyAction,
  type ContactPublicKeyActionRegistry,
  type ContactsService,
  type KeyspaceService
} from "@keymaster/contracts";

const COMPRESSED_PUBLIC_KEY = /^(02|03)[0-9a-f]{64}$/i;
type ScanMode = "camera" | "image";

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new window.Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Image could not be loaded."));
    image.src = url;
  });
}

function publicKeyFromQr(value: string): string | null {
  const trimmed = value.trim();
  if (COMPRESSED_PUBLIC_KEY.test(trimmed)) return trimmed.toLowerCase();
  try {
    const parsed = JSON.parse(trimmed) as { publicKeyHex?: unknown };
    if (typeof parsed.publicKeyHex === "string" && COMPRESSED_PUBLIC_KEY.test(parsed.publicKeyHex.trim())) {
      return parsed.publicKeyHex.trim().toLowerCase();
    }
  } catch {
    // QR payloads are normally the raw public key; non-JSON payloads need no special handling.
  }
  return null;
}

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
  const { t } = useI18n();
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
      {copied ? t("home.action.copied", { defaultValue: "已复制" }) : t("home.action.copy", { defaultValue: "拷贝" })}
    </Button>
  );
}

function MyInfoModal({ open, onClose, publicKeyHex, hasP2pkh }: { open: boolean; onClose: () => void; publicKeyHex?: string; hasP2pkh: boolean }) {
  const { t } = useI18n();
  const address = useMemo(() => p2pkhAddress(publicKeyHex, "mainnet"), [publicKeyHex]);

  return (
    <Modal open={open} onClose={onClose} title={t("home.info.title", { defaultValue: "我的信息" })} closeButtonLabel={t("home.info.close", { defaultValue: "关闭我的信息" })} data-testid="home-my-info-modal">
      {!publicKeyHex ? (
        <p className="home-actions__hint">{t("home.info.noKey", { defaultValue: "请选择一个可用的密钥后再查看信息。" })}</p>
      ) : (
        <div className="home-actions__identity">
          <div className="home-actions__qr" aria-label={t("home.info.publicKeyQr", { defaultValue: "公钥二维码" })}>
            <QRCodeSVG value={publicKeyHex} size={196} level="M" includeMargin />
          </div>
          <IdentityRow label={t("home.info.publicKey", { defaultValue: "公钥" })} value={publicKeyHex} shortValue={formatShortPublicKey(publicKeyHex)} />
          {address ? <IdentityRow label={t("home.info.address", { defaultValue: "地址" })} value={address} /> : null}
          {hasP2pkh ? <TestnetAddress publicKeyHex={publicKeyHex} /> : null}
        </div>
      )}
    </Modal>
  );
}

function TestnetAddress({ publicKeyHex }: { publicKeyHex: string }) {
  const host = usePluginHost();
  const { t } = useI18n();
  const includeTestnet = useResourceSelector<{ includeTestnet: boolean }, boolean>(
    host.resourceStore,
    "p2pkh.settings",
    [],
    (snapshot) => snapshot.data?.includeTestnet ?? false
  );
  const address = useMemo(() => p2pkhAddress(publicKeyHex, "testnet"), [publicKeyHex]);
  if (!includeTestnet || !address) return null;
  return <IdentityRow label={t("home.info.testnetAddress", { defaultValue: "Testnet 地址" })} value={address} />;
}

function IdentityRow({ label, value, shortValue }: { label: string; value: string; shortValue?: string }) {
  return <div className="home-actions__identity-row">
    <span className="home-actions__identity-label">{label}</span>
    <code title={value}>{shortValue ?? value}</code>
    <CopyButton value={value} />
  </div>;
}

export function HomeActions() {
  const keyspace = useCapability<KeyspaceService>("keyspace.service");
  const contacts = useCapability<ContactsService>("contacts.service");
  const actionRegistry = useCapability<ContactPublicKeyActionRegistry>(CONTACT_PUBLIC_KEY_ACTION_REGISTRY_CAPABILITY);
  const hasP2pkh = useHasCapability("p2pkh.service");
  const host = usePluginHost();
  const { t } = useI18n();
  const actions = useRegistry(() => actionRegistry.list()).map((action) => ({ action, label: host.i18n.text(action.label) }));
  const [activePublicKeyHex, setActivePublicKeyHex] = useState(() => keyspace.active().activePublicKeyHex);
  const [infoOpen, setInfoOpen] = useState(false);
  const [scanOpen, setScanOpen] = useState(false);
  const [scanMode, setScanMode] = useState<ScanMode>("camera");
  const [scannerActive, setScannerActive] = useState(false);
  const [imageScanning, setImageScanning] = useState(false);
  const [imagePreviewUrl, setImagePreviewUrl] = useState<string | null>(null);
  const [scanError, setScanError] = useState<string | null>(null);
  const [scannedPublicKeyHex, setScannedPublicKeyHex] = useState<string | null>(null);
  const [contact, setContact] = useState<Contact | null>(null);
  const [contactLoading, setContactLoading] = useState(false);
  const [actionPending, setActionPending] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [contactName, setContactName] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const imageRecognitionId = useRef(0);

  useEffect(() => keyspace.onActiveKeyChanged((state) => setActivePublicKeyHex(state.activePublicKeyHex)), [keyspace]);

  const acceptQrValue = useCallback((value: string) => {
    const publicKeyHex = publicKeyFromQr(value);
    if (!publicKeyHex) {
      setScanError(t("home.scan.invalid", { defaultValue: "二维码中没有有效的压缩公钥。" }));
      return;
    }
    setScanError(null);
    setScannedPublicKeyHex(publicKeyHex);
    setScannerActive(false);
  }, [t]);

  useEffect(() => {
    if (!scanOpen || scanMode !== "camera" || !scannerActive) return;
    if (!navigator.mediaDevices?.getUserMedia || !videoRef.current) {
      setScanError(t("home.scan.unsupported", { defaultValue: "当前浏览器不支持二维码扫描，请手动输入公钥。" }));
      setScannerActive(false);
      return;
    }

    let cancelled = false;
    let stop: (() => void) | null = null;
    const reader = new BrowserQRCodeReader(undefined, { delayBetweenScanAttempts: 180 });

    void reader.decodeFromConstraints(
      { video: { facingMode: { ideal: "environment" } }, audio: false },
      videoRef.current,
      (result, _error, controls) => {
        if (cancelled || !result) return;
        controls.stop();
        acceptQrValue(result.getText());
      }
    )
      .then((controls) => {
        stop = controls.stop;
        if (cancelled) controls.stop();
      })
      .catch(() => {
        if (!cancelled) {
          setScanError(t("home.scan.cameraError", { defaultValue: "无法打开相机，请检查浏览器授权。" }));
          setScannerActive(false);
        }
      });

    return () => {
      cancelled = true;
      stop?.();
    };
  }, [acceptQrValue, scanMode, scanOpen, scannerActive, t]);

  useEffect(() => () => {
    if (imagePreviewUrl) URL.revokeObjectURL(imagePreviewUrl);
  }, [imagePreviewUrl]);

  useEffect(() => {
    if (!scannedPublicKeyHex) {
      setContact(null);
      return;
    }
    let cancelled = false;
    setContactLoading(true);
    setContact(null);
    void contacts.findByPublicKeyHex(scannedPublicKeyHex)
      .then((found) => { if (!cancelled) setContact(found ?? null); })
      .catch(() => { if (!cancelled) setScanError(t("home.scan.contactError", { defaultValue: "无法读取联系人信息。" })); })
      .finally(() => { if (!cancelled) setContactLoading(false); });
    return () => { cancelled = true; };
  }, [contacts, scannedPublicKeyHex, t]);

  function openScanner() {
    setScanError(null);
    setScannedPublicKeyHex(null);
    setContact(null);
    setCreateOpen(false);
    setCreateError(null);
    setContactName("");
    setScanMode("camera");
    setScannerActive(true);
    setScanOpen(true);
  }

  function closeScanner() {
    imageRecognitionId.current += 1;
    setImageScanning(false);
    setScannerActive(false);
    setScanOpen(false);
  }

  function selectScanMode(mode: ScanMode) {
    imageRecognitionId.current += 1;
    setImageScanning(false);
    setScanError(null);
    setScanMode(mode);
    setScannerActive(mode === "camera");
  }

  async function recognizeImage(file: File | undefined) {
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      setScanError(t("home.scan.imageTypeError", { defaultValue: "请选择一张图片文件。" }));
      return;
    }

    const previewUrl = URL.createObjectURL(file);
    const recognitionId = imageRecognitionId.current + 1;
    imageRecognitionId.current = recognitionId;
    setImagePreviewUrl((previousUrl) => {
      if (previousUrl) URL.revokeObjectURL(previousUrl);
      return previewUrl;
    });
    setScanError(null);
    setImageScanning(true);
    try {
      const image = await loadImage(previewUrl);
      const result = await new BrowserQRCodeReader().decodeFromImageElement(image);
      if (recognitionId !== imageRecognitionId.current) return;
      acceptQrValue(result.getText());
    } catch {
      if (recognitionId === imageRecognitionId.current) {
        setScanError(t("home.scan.imageNotFound", { defaultValue: "未能在这张图片中识别出二维码。" }));
      }
    } finally {
      if (recognitionId === imageRecognitionId.current) setImageScanning(false);
      if (imageInputRef.current) imageInputRef.current.value = "";
    }
  }

  async function runAction(action: ContactPublicKeyAction) {
    if (!scannedPublicKeyHex || actionPending) return;
    setActionError(null);
    setActionPending(action.id);
    try {
      await action.run({ publicKeyHex: scannedPublicKeyHex });
      closeScanner();
    } catch {
      setActionError(t("home.scan.actionError", { defaultValue: "操作失败，请重试。" }));
    } finally {
      setActionPending(null);
    }
  }

  async function createContact() {
    if (!scannedPublicKeyHex || !contactName.trim() || creating) return;
    setCreating(true);
    setCreateError(null);
    try {
      const saved = await contacts.addContact({ publicKeyHex: scannedPublicKeyHex, name: contactName.trim() });
      setContact(saved);
      setCreateOpen(false);
    } catch (error) {
      setCreateError(error instanceof Error ? error.message : t("home.scan.createError", { defaultValue: "创建联系人失败。" }));
    } finally {
      setCreating(false);
    }
  }

  return (
    <section className="home-actions" aria-label={t("home.actions.label", { defaultValue: "首页操作" })}>
      <div className="home-actions__grid">
        <button type="button" className="home-actions__shortcut" onClick={openScanner} data-testid="home-scan-button">
          <span className="home-actions__icon"><ScanLine size={28} strokeWidth={1.8} /></span>
          <span>{t("home.action.scan", { defaultValue: "扫描" })}</span>
        </button>
        <button type="button" className="home-actions__shortcut" onClick={() => setInfoOpen(true)} data-testid="home-my-info-button">
          <span className="home-actions__icon home-actions__icon--info"><UserRound size={28} strokeWidth={1.8} /></span>
          <span>{t("home.action.myInfo", { defaultValue: "我的信息" })}</span>
        </button>
      </div>

      <MyInfoModal open={infoOpen} onClose={() => setInfoOpen(false)} publicKeyHex={activePublicKeyHex} hasP2pkh={hasP2pkh} />
      <Modal open={scanOpen} onClose={closeScanner} title={t("home.scan.title", { defaultValue: "扫描公钥二维码" })} closeButtonLabel={t("home.scan.close", { defaultValue: "关闭扫描" })} data-testid="home-scan-modal">
        <div className="home-actions__scan">
          {!scannedPublicKeyHex ? <div className="home-actions__scan-modes" role="tablist" aria-label={t("home.scan.modeLabel", { defaultValue: "识别方式" })}>
            <button type="button" role="tab" aria-selected={scanMode === "camera"} className={scanMode === "camera" ? "is-active" : ""} onClick={() => selectScanMode("camera")}>
              <Camera size={16} />{t("home.scan.cameraMode", { defaultValue: "扫描" })}
            </button>
            <button type="button" role="tab" aria-selected={scanMode === "image"} className={scanMode === "image" ? "is-active" : ""} onClick={() => selectScanMode("image")}>
              <Image size={16} />{t("home.scan.imageMode", { defaultValue: "图片识别" })}
            </button>
          </div> : null}
          {scanMode === "camera" && scannerActive ? (
            <div className="home-actions__camera-wrap">
              <video ref={videoRef} className="home-actions__camera" muted playsInline aria-label={t("home.scan.camera", { defaultValue: "二维码扫描画面" })} />
              <span className="home-actions__scan-frame" aria-hidden="true" />
            </div>
          ) : null}
          {!scannedPublicKeyHex && scanMode === "camera" ? <p className="home-actions__hint"><Camera size={16} />{t("home.scan.hint", { defaultValue: "将对方的公钥二维码置于取景框内。" })}</p> : null}
          {!scannedPublicKeyHex && scanMode === "image" ? <div className="home-actions__image-picker">
            {imagePreviewUrl ? <img src={imagePreviewUrl} alt={t("home.scan.imagePreview", { defaultValue: "待识别图片预览" })} /> : <Image size={32} strokeWidth={1.5} aria-hidden="true" />}
            <div>
              <Button variant="secondary" loading={imageScanning} onClick={() => imageInputRef.current?.click()}>
                {t("home.scan.chooseImage", { defaultValue: "选择图片" })}
              </Button>
              <p className="home-actions__hint">{t("home.scan.imageHint", { defaultValue: "图片仅在此设备本地识别，不会上传。" })}</p>
            </div>
            <input ref={imageInputRef} className="home-actions__image-input" type="file" accept="image/*" onChange={(event) => void recognizeImage(event.currentTarget.files?.[0])} />
          </div> : null}
          {scanError ? <p className="home-actions__error" role="alert">{scanError}</p> : null}
          {!scannedPublicKeyHex ? <ManualPublicKeyInput onSubmit={acceptQrValue} /> : null}
          {scannedPublicKeyHex ? <ScannedContact
            publicKeyHex={scannedPublicKeyHex}
            contact={contact}
            loading={contactLoading}
            actions={actions}
            pending={actionPending}
            error={actionError}
            createOpen={createOpen}
            contactName={contactName}
            creating={creating}
            createError={createError}
            onRun={runAction}
            onShowCreate={() => setCreateOpen(true)}
            onContactName={setContactName}
            onCreate={() => void createContact()}
          /> : null}
        </div>
      </Modal>
    </section>
  );
}

function ManualPublicKeyInput({ onSubmit }: { onSubmit: (value: string) => void }) {
  const { t } = useI18n();
  const [value, setValue] = useState("");
  return <div className="home-actions__manual">
    <TextInput label={t("home.scan.manual", { defaultValue: "或输入对方公钥" })} value={value} onChange={(event) => setValue(event.currentTarget.value)} />
    <Button variant="secondary" onClick={() => onSubmit(value)}>{t("home.scan.confirm", { defaultValue: "确认" })}</Button>
  </div>;
}

function ScannedContact(props: {
  publicKeyHex: string;
  contact: Contact | null;
  loading: boolean;
  actions: Array<{ action: ContactPublicKeyAction; label: string }>;
  pending: string | null;
  error: string | null;
  createOpen: boolean;
  contactName: string;
  creating: boolean;
  createError: string | null;
  onRun: (action: ContactPublicKeyAction) => Promise<void>;
  onShowCreate: () => void;
  onContactName: (name: string) => void;
  onCreate: () => void;
}) {
  const { t } = useI18n();
  return <div className="home-actions__scanned">
    <div className="home-actions__scanned-key"><span>{t("home.scan.publicKey", { defaultValue: "对方公钥" })}</span><code title={props.publicKeyHex}>{formatShortPublicKey(props.publicKeyHex)}</code></div>
    {props.loading ? <p className="home-actions__hint">{t("home.scan.contactLoading", { defaultValue: "正在查询联系人…" })}</p> : null}
    {!props.loading && props.contact ? <p className="home-actions__contact"><UserRound size={16} />{props.contact.name}</p> : null}
    {!props.loading && !props.contact && !props.createOpen ? <Button variant="secondary" iconLeft={<UserPlus size={16} />} onClick={props.onShowCreate}>{t("home.scan.createContact", { defaultValue: "创建联系人" })}</Button> : null}
    {!props.loading && !props.contact && props.createOpen ? <div className="home-actions__create">
      <TextInput label={t("home.scan.contactName", { defaultValue: "联系人名称" })} value={props.contactName} onChange={(event) => props.onContactName(event.currentTarget.value)} error={props.createError ?? undefined} />
      <Button onClick={props.onCreate} loading={props.creating}>{t("home.scan.saveContact", { defaultValue: "保存联系人" })}</Button>
    </div> : null}
    <div className="home-actions__contact-actions">
      {props.actions.map(({ action, label }) => <Button key={action.id} variant="secondary" size="sm" disabled={Boolean(props.pending)} onClick={() => void props.onRun(action)}>{label}</Button>)}
    </div>
    {props.error ? <p className="home-actions__error" role="alert">{props.error}</p> : null}
  </div>;
}
