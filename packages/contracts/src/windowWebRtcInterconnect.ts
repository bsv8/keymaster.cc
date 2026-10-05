// 只包含跨插件共享的类型，运行实现仍由 Window P2P 拥有。
import type { WebRTCInterconnectConnectionEvent, WebRTCInterconnectDialer, WebRTCInterconnectEnvelope } from "bitcoin-libp2p/webrtc-interconnect";
type SignalSender = (envelope: WebRTCInterconnectEnvelope) => Promise<void> | void;

export interface WindowWebRtcInterconnectContext {
  readonly dialer: WebRTCInterconnectDialer;
  register(connectionId: string, send: SignalSender): () => void;
  deliver(envelope: WebRTCInterconnectEnvelope): void;
  setStunServers(servers: readonly string[]): void;
  onConnection(listener: (event: WebRTCInterconnectConnectionEvent) => void): () => void;
  dispose(): void;
}

