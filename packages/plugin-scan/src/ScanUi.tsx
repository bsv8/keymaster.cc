import { createContext, useContext, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { BrowserQRCodeReader } from "@zxing/browser";
import { Camera, Image } from "lucide-react";
import { Button, Modal, TextInput } from "@keymaster/ui";
import { usePluginI18n } from "@keymaster/runtime";
import type { UriActionResolution, UriActionView } from "@keymaster/contracts";
import type { UriRouter } from "./uriRouter.js";
const Context = createContext<{ router: UriRouter; resolver: UriActionView } | undefined>(undefined);
export const ScanContextProvider = Context.Provider;
function useScan() { const context = useContext(Context); if (!context) throw new Error("Scan requires its own instance context"); return context; }
export function ScanFrame() {
  const { router } = useScan();
  useSyncExternalStore(router.subscribe, router.revision, router.revision);
  const { t } = usePluginI18n();
  const state = router.snapshot();
  if (!state || state.scope.state !== "active") return null;
  return <Modal open onClose={router.close} title={t(state.selected ? "scan.action.title" : "scan.title")} closeButtonLabel={t("scan.close")} data-testid="home-scan-modal">
    {state.selected ? router.renderSelected() : <ScanInput initialInput={state.input} />}
  </Modal>;
}
function ScanInput({ initialInput }: { initialInput?: string }) {
  const { resolver, router } = useScan();
  const { t, text } = usePluginI18n();
  const [mode, setMode] = useState<"camera" | "image" | "text">(initialInput ? "text" : "camera");
  const [cameraActive, setCameraActive] = useState(!initialInput);
  const [value, setValue] = useState(initialInput ?? "");
  const [resolution, setResolution] = useState<UriActionResolution>();
  const [error, setError] = useState<string>();
  const [imageBusy, setImageBusy] = useState(false);
  const [preview, setPreview] = useState<string>();
  const video = useRef<HTMLVideoElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const generation = useRef(0);
  const initialHandled = useRef(false);
  const acceptRef = useRef<(raw: string) => void>(() => {});
  const accept = (raw: string) => {
    setCameraActive(false); generation.current++;
    try {
      if (resolution) resolver.release(resolution.id);
      const result = resolver.resolve(raw);
      setResolution(result); setValue(raw); setError(undefined);
    } catch { setError(t("scan.invalid")); }
  };
  acceptRef.current = accept;
  useEffect(() => {
    if (initialInput && !initialHandled.current) { initialHandled.current = true; acceptRef.current(initialInput); }
  }, [initialInput]);
  useEffect(() => {
    if (mode !== "camera" || !cameraActive || !video.current) return;
    let cancelled = false;
    let stop: (() => void) | undefined;
    if (!navigator.mediaDevices?.getUserMedia) { setError(t("scan.unsupported")); setCameraActive(false); return; }
    void new BrowserQRCodeReader(undefined, { delayBetweenScanAttempts: 180 }).decodeFromConstraints({ video: { facingMode: { ideal: "environment" } }, audio: false }, video.current, (result, _error, controls) => {
      if (cancelled || !result) return;
      controls.stop(); acceptRef.current(result.getText());
    }).then(controls => { stop = () => controls.stop(); if (cancelled) controls.stop(); }).catch(() => { if (!cancelled) { setError(t("scan.cameraError")); setCameraActive(false); } });
    return () => { cancelled = true; stop?.(); };
  }, [mode, cameraActive, t]);
  useEffect(() => () => { generation.current++; }, []);
  useEffect(() => () => {
    // Activating an action transfers this session to business UI; other exits discard input.
    if (resolution && router.snapshot()?.selected?.session.id !== resolution.id) {
      try { resolver.release(resolution.id); } catch { /* Owner or session has already been revoked. */ }
    }
  }, [resolution, resolver, router]);
  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview); }, [preview]);
  const selectMode = (next: typeof mode) => {
    generation.current++; setImageBusy(false); setMode(next); setCameraActive(next === "camera"); setError(undefined);
  };
  async function readImage(file?: File) {
    if (!file) return;
    if (!file.type.startsWith("image/")) { setError(t("scan.imageType")); return; }
    const url = URL.createObjectURL(file), current = ++generation.current;
    setPreview(url); setImageBusy(true); setError(undefined);
    try {
      const image = new window.Image();
      await new Promise<void>((resolve, reject) => { image.onload = () => resolve(); image.onerror = reject; image.src = url; });
      if (generation.current !== current) return;
      const reader = new BrowserQRCodeReader();
      let result;
      // Some QR patterns fool the detector at a particular pixel scale. Retry locally
      // at bounded resolutions and rotation rather than rejecting a valid image.
      const canvas = document.createElement("canvas");
      const context = canvas.getContext("2d")!;
      for (const [limit, rotated] of [[1024, false], [512, false], [512, true]] as const) {
        if (generation.current !== current) return;
        const ratio = Math.min(1, limit / Math.max(image.naturalWidth, image.naturalHeight));
        const width = Math.max(1, Math.round(image.naturalWidth * ratio));
        const height = Math.max(1, Math.round(image.naturalHeight * ratio));
        canvas.width = rotated ? height : width; canvas.height = rotated ? width : height;
        context.fillStyle = "white"; context.fillRect(0, 0, canvas.width, canvas.height);
        context.save();
        if (rotated) { context.translate(height, 0); context.rotate(Math.PI / 2); }
        context.drawImage(image, 0, 0, width, height); context.restore();
        try { result = reader.decodeFromCanvas(canvas); break; } catch { /* Try the next local projection. */ }
      }
      if (!result) throw new Error("No QR code found");
      if (generation.current === current) { setImageBusy(false); acceptRef.current(result.getText()); }
    } catch { if (generation.current === current) setError(t("scan.imageNotFound")); }
    finally { if (generation.current === current) setImageBusy(false); if (input.current) input.current.value = ""; }
  }
  function retry() {
    if (resolution) { try { resolver.release(resolution.id); } catch { /* 已撤销的解析不再保留输入。 */ } }
    setResolution(undefined); setError(undefined); setCameraActive(mode === "camera");
  }
  return <div className="home-actions__scan">
    {!resolution ? <>
      <div className="home-actions__scan-modes" role="tablist" aria-label={t("scan.modes")}>
        {(["camera", "image", "text"] as const).map(item => <button key={item} type="button" role="tab" aria-selected={mode === item} onClick={() => selectMode(item)}>{item === "camera" ? <Camera size={16} /> : item === "image" ? <Image size={16} /> : null}{t("scan.mode." + item)}</button>)}
      </div>
      {mode === "camera" && cameraActive ? <div className="home-actions__camera-wrap"><video ref={video} muted playsInline className="home-actions__camera" aria-label={t("scan.camera")} /><span className="home-actions__scan-frame" /></div> : null}
      {mode === "image" ? <div className="home-actions__image-picker">
        {preview ? <img src={preview} alt={t("scan.preview")} /> : <Image size={32} />}
        <Button variant="secondary" loading={imageBusy} onClick={() => input.current?.click()}>{t("scan.chooseImage")}</Button>
        <input ref={input} type="file" accept="image/*" className="home-actions__image-input" onChange={event => void readImage(event.currentTarget.files?.[0])} />
        <p>{t("scan.localImage")}</p>
      </div> : null}
      <TextInput label={t("scan.input")} value={value} onChange={event => setValue(event.currentTarget.value)} />
      <Button onClick={() => accept(value)}>{t("scan.recognize")}</Button>
    </> : <div data-testid="scan-results">
      <p>{t(resolution.candidates.length ? "scan.chooseAction" : "scan.noMatch")}</p>
      <div className="scan-action-list">{resolution.candidates.map(candidate => <Button key={candidate.id} variant="secondary" onClick={() => {
        try { resolver.activate(resolution.id, candidate.id); } catch { setError(t("scan.expired")); }
      }}>{text(candidate.label)}{candidate.description ? <small>{text(candidate.description)}</small> : null}</Button>)}</div>
      <Button variant="ghost" onClick={retry}>{t("scan.again")}</Button>
    </div>}
    {error ? <p role="alert" className="home-actions__error">{error}</p> : null}
  </div>;
}
