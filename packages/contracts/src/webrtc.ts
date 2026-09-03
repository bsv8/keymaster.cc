// WebRTC capability 的跨插件公共契约。
//
// plugin-message 只通过 `webrtc.service` 使用这些类型，不能 import
// plugin-webrtc 的实现包；plugin-webrtc 可在内部拥有更宽的 service API。

/** `webrtc.service` capability 的稳定 key。 */
export const WEBRTC_SERVICE_CAPABILITY = "webrtc.service";

export type WebrtcMode = "audio" | "video";

export type WebrtcSessionPhase =
  | "idle"
  | "inviting"
  | "incoming"
  | "connecting"
  | "connected"
  | "ended";

export type WebrtcBlockReason =
  | "service_not_ready"
  | "invalid_target"
  | "device_unavailable"
  | "send_invite_failed"
  | "create_offer_failed"
  | "busy_local"
  | "invalid_state";

export interface WebrtcRemoteNotice {
  kind: "fallback_suggested" | "rejected" | "busy";
  message: string;
  suggestedMode?: WebrtcMode;
}

export interface WebrtcSessionSnapshot {
  phase: WebrtcSessionPhase;
  remotePublicKeyHex: string | null;
  direction: "outgoing" | "incoming" | null;
  mode: WebrtcMode | null;
  hasLocalStream: boolean;
  hasRemoteStream: boolean;
  remoteNotice: WebrtcRemoteNotice | null;
  serviceReady: boolean;
  lastError: WebrtcBlockReason | null;
}

export type WebrtcHistoryItem =
  | {
      itemType: "call";
      recordId: string;
      ownerPublicKeyHex: string;
      peerPublicKeyHex: string;
      kind: "audio_call" | "video_call";
      direction: "outgoing" | "incoming";
      status: "completed" | "missed" | "rejected" | "failed";
      startedAtMs: number;
      endedAtMs?: number;
      durationSec?: number;
      note?: string;
    }
  | {
      itemType: "transfer";
      recordId: string;
      ownerPublicKeyHex: string;
      peerPublicKeyHex: string;
      kind: "image" | "file";
      direction: "outgoing" | "incoming";
      status: "completed" | "failed";
      startedAtMs: number;
      endedAtMs?: number;
      durationSec?: number;
      fileName?: string;
      mimeType?: string;
      byteLength?: number;
      blobKey?: string;
    };

/** plugin-message 消费 `webrtc.service` 所需的最小 API。 */
export interface WebrtcMessageService {
  snapshot(): WebrtcSessionSnapshot;
  subscribe(handler: (snapshot: WebrtcSessionSnapshot) => void): () => void;
  listHistoryForPeer(peerPublicKeyHex: string): Promise<WebrtcHistoryItem[]>;
  getTransferBlob(blobKey: string): Promise<Blob | null>;
  startCall(input: { targetPublicKeyHex: string; mode: WebrtcMode }): Promise<void>;
  sendImage(input: { targetPublicKeyHex: string; file: Blob | File }): Promise<void>;
  sendFile(input: { targetPublicKeyHex: string; file: Blob | File }): Promise<void>;
  acceptIncoming(): Promise<void>;
  rejectIncoming(): Promise<void>;
  hangup(): Promise<void>;
  attachToVideo(direction: "local" | "remote", videoEl: HTMLVideoElement): () => void;
}
