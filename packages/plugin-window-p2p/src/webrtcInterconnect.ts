import {
  createWebRTCInterconnectDialer,
  type WebRTCInterconnectConnectionEvent,
  type WebRTCInterconnectDialer,
  type WebRTCInterconnectEnvelope,
  type WebRTCInterconnectSignalingAdapter
} from "bitcoin-libp2p/webrtc-interconnect";

type SignalSender = (envelope: WebRTCInterconnectEnvelope) => Promise<void> | void;

export interface WindowWebRtcInterconnectContext {
  readonly dialer: WebRTCInterconnectDialer;
  register(connectionId: string, send: SignalSender): () => void;
  deliver(envelope: WebRTCInterconnectEnvelope): void;
  setStunServers(servers: readonly string[]): void;
  onConnection(listener: (event: WebRTCInterconnectConnectionEvent) => void): () => void;
  dispose(): void;
}

class ExternalSignalingRouter implements WebRTCInterconnectSignalingAdapter {
  private readonly routes = new Map<string, SignalSender>();
  private readonly pending: WebRTCInterconnectEnvelope[] = [];
  private listener?: (signal: WebRTCInterconnectEnvelope) => void;
  private stunServers: string[] = [];

  send = async (envelope: WebRTCInterconnectEnvelope): Promise<void> => {
    const route = this.routes.get(envelope.connectionId);
    if (route == null) throw new Error("WebRTC interconnect route is not registered");
    await route(envelope);
  };

  subscribe = (listener: (signal: WebRTCInterconnectEnvelope) => void): (() => void) => {
    if (this.listener != null && this.listener !== listener) throw new Error("WebRTC interconnect listener is already registered");
    this.listener = listener;
    const queued = this.pending.splice(0);
    for (const envelope of queued) listener(envelope);
    return () => {
      if (this.listener === listener) this.listener = undefined;
    };
  };

  register (connectionId: string, send: SignalSender): () => void {
    if (connectionId.length === 0 || this.routes.has(connectionId)) throw new Error("WebRTC interconnect route is invalid or already registered");
    this.routes.set(connectionId, send);
    return () => {
      if (this.routes.get(connectionId) === send) this.routes.delete(connectionId);
    };
  };

  deliver (envelope: WebRTCInterconnectEnvelope): void {
    if (this.listener == null) {
      if (this.pending.length >= 32) throw new Error("WebRTC interconnect pending signal limit reached");
      this.pending.push(envelope);
      return;
    }
    this.listener(envelope);
  }

  setStunServers (servers: readonly string[]): void {
    this.stunServers = [...new Set(servers.filter(server => typeof server === "string" && server.startsWith("stun:")))].slice(0, 16);
  }

  configuration (): RTCConfiguration {
    return { iceServers: this.stunServers.map(url => ({ urls: [url] })) };
  }

  dispose (): void {
    this.routes.clear();
    this.pending.length = 0;
    this.listener = undefined;
  }
}

export function createWindowWebRtcInterconnect (): WindowWebRtcInterconnectContext {
  const router = new ExternalSignalingRouter();
  const dialer = createWebRTCInterconnectDialer({
    signaling: router,
    rtcConfiguration: () => router.configuration()
  });
  return {
    dialer,
    register: (connectionId, send) => router.register(connectionId, send),
    deliver: envelope => router.deliver(envelope),
    setStunServers: servers => router.setStunServers(servers),
    onConnection: listener => dialer.onConnection(listener),
    dispose: () => router.dispose()
  };
}
