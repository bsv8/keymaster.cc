// packages/plugin-message/src/MessageDetailPage.test.tsx
// 会话详情页契约测试。

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type {
  ActiveKeyState,
  AppMsgMessage,
  I18nService,
  I18nText,
  I18nValues,
  KeyspaceService,
  LanguageMode,
  SupportedLanguage,
  SupportedLanguageDescriptor
} from "@keymaster/contracts";
import { I18N_SERVICE_CAPABILITY } from "@keymaster/contracts";
import { PluginHostProvider } from "@keymaster/runtime";
import type { PluginHost } from "@keymaster/runtime";
import type { MessageService } from "./messageService.js";
import type { WebrtcService, WebrtcHistoryItem } from "@keymaster/plugin-webrtc";

const OWNER = "02bbbb".padEnd(66, "b");
const MESSAGE_SERVICE_CAPABILITY = "message.service";
const KEYSPACE_SERVICE_CAPABILITY = "keyspace.service";
const WEBRTC_SERVICE_CAPABILITY = "webrtc.service";

function makeFakeI18n(): I18nService {
  return {
    mode: (): LanguageMode => "manual",
    language: (): SupportedLanguage => "en",
    supported: (): readonly SupportedLanguageDescriptor[] => [],
    t: (key: string, _values?: I18nValues): string => key,
    text: (input: I18nText | undefined): string => {
      if (!input) return "";
      if (typeof input === "string") return input;
      return input.fallback ?? input.key;
    },
    setLanguage: async (_l: SupportedLanguage): Promise<void> => undefined,
    setAuto: async (): Promise<void> => undefined,
    registerResources: () => undefined,
    unregisterResources: () => undefined,
    onChange: () => () => undefined
  };
}

function makeFakeKeyspace(): KeyspaceService {
  const listeners = new Set<(state: ActiveKeyState) => void>();
  let active: ActiveKeyState = { activePublicKeyHex: OWNER };
  return {
    listKeys: async () => [],
    getKey: async () => undefined,
    active: () => active,
    setActive: async (publicKeyHex: string) => {
      active = { activePublicKeyHex: publicKeyHex };
      for (const listener of listeners) listener(active);
    },
    requireActiveKey: () => ({ publicKeyHex: OWNER, label: "fake", capabilities: [], createdAt: "" }),
    onActiveChange: (handler) => {
      listeners.add(handler);
      return () => listeners.delete(handler);
    },
    openKeyStorage: async () => {
      throw new Error("not implemented");
    },
    registerPluginStorage: () => undefined,
    listPluginStorages: () => [],
    prepareDeleteKey: async () => undefined,
    deleteKey: async () => undefined,
    isInitializing: () => false,
    onInitializationChange: () => () => undefined
  };
}

function makeFakeService(opts?: { messages?: AppMsgMessage[]; onListMessages?: (input?: { limit?: number; afterMessageId?: string }) => void }): MessageService {
  const messages = opts?.messages ?? [];
  return {
    isReady: () => true,
    listMessages: async (input) => {
      opts?.onListMessages?.(input);
      return messages;
    },
    getMessage: async (id: string) => messages.find((m) => m.messageId === id) ?? null,
    sendTextMessage: async () => undefined,
    subscribeMessages: () => () => undefined
  };
}

function makeFakeWebrtcService(opts?: {
  snapshot?: import("@keymaster/plugin-webrtc").WebrtcSessionSnapshot;
  startCallSnapshot?: import("@keymaster/plugin-webrtc").WebrtcSessionSnapshot | ((input: { targetPublicKeyHex: string; mode: "audio" | "video" }) => import("@keymaster/plugin-webrtc").WebrtcSessionSnapshot);
  history?: WebrtcHistoryItem[];
  sendImage?: (input: { targetPublicKeyHex: string; file: Blob | File }) => Promise<void>;
  sendFile?: (input: { targetPublicKeyHex: string; file: Blob | File }) => Promise<void>;
  attachToVideo?: (direction: "local" | "remote", videoEl: HTMLVideoElement) => void;
}): WebrtcService {
  const history = opts?.history ?? [];
  let currentSnapshot = opts?.snapshot ?? {
    phase: "idle",
    remotePublicKeyHex: null,
    direction: null,
    mode: null,
    hasLocalStream: false,
    hasRemoteStream: false,
    remoteNotice: null,
    serviceReady: true,
    lastError: null
  };
  const subscribers = new Set<(snapshot: import("@keymaster/plugin-webrtc").WebrtcSessionSnapshot) => void>();
  return {
    snapshot: () => currentSnapshot,
    subscribe: (handler) => {
      subscribers.add(handler);
      handler(currentSnapshot);
      return () => subscribers.delete(handler);
    },
    isReady: () => true,
    checkPeerOnline: async () => "online",
    listHistoryForPeer: async () => history,
    getTransferBlob: async () => null,
    startCall: async (input) => {
      if (!opts?.startCallSnapshot) return undefined;
      currentSnapshot =
        typeof opts.startCallSnapshot === "function"
          ? opts.startCallSnapshot(input)
          : opts.startCallSnapshot;
      for (const handler of subscribers) {
        handler(currentSnapshot);
      }
      return undefined;
    },
    sendImage: opts?.sendImage ?? (async () => undefined),
    sendFile: opts?.sendFile ?? (async () => undefined),
    acceptIncoming: async () => undefined,
    rejectIncoming: async () => undefined,
    hangup: async () => undefined,
    consumeRemoteNotice: () => undefined,
    attachToVideo: (direction, videoEl) => {
      opts?.attachToVideo?.(direction, videoEl);
      return () => undefined;
    },
    runStunDiagnostics: async () => [],
    getStunServers: () => [],
    applyStunServers: async () => undefined,
    dispose: () => undefined
  };
}

function makeFakeHost(service: MessageService | null, webrtcService?: WebrtcService | null): PluginHost {
  const providers: Record<string, unknown> = {
    [I18N_SERVICE_CAPABILITY]: makeFakeI18n(),
    [KEYSPACE_SERVICE_CAPABILITY]: makeFakeKeyspace()
  };
  if (service) {
    providers[MESSAGE_SERVICE_CAPABILITY] = service;
  }
  if (webrtcService) {
    providers[WEBRTC_SERVICE_CAPABILITY] = webrtcService;
  }
  const capabilities = {
    keys: () => Object.keys(providers),
    get: <T,>(key: string): T => {
      if (key in providers) return providers[key] as T;
      throw new Error(`not provided: ${key}`);
    },
    has: (key: string) => key in providers,
    require: <T,>(key: string): T => {
      if (key in providers) return providers[key] as T;
      throw new Error(`not provided: ${key}`);
    },
    provide: <T,>(k: string, v: T) => {
      providers[k] = v;
    },
    revoke: (k: string) => {
      delete providers[k];
    }
  };
  const host = {
    capabilities,
    messageBus: {} as never,
    routes: {} as never,
    menus: {} as never,
    breadcrumbs: {} as never,
    settings: {} as never,
    home: {} as never,
    commands: {} as never,
    importers: {} as never,
    transfers: {} as never,
    assets: {} as never,
    tokens: {} as never,
    collectibles: {} as never,
    collectibleTransfer: {} as never,
    topbar: {} as never,
    i18n: makeFakeI18n(),
    log: {} as never,
    configStore: {} as never,
    installed: () => [],
    manifests: () => [],
    state: () => ({ id: "fake", kind: "enabled" }),
    graph: () => ({
      plugins: [],
      dependencies: {},
      provides: {},
      reverse: {}
    }),
    version: () => 1,
    subscribe: () => () => undefined,
    getManifest: () => undefined,
    reverseDeps: () => [],
    register: async () => undefined,
    registerAll: async () => undefined,
    enable: async () => undefined,
    disable: async () => ({ ok: true as const }),
    unregister: async () => undefined
  };
  return host as unknown as PluginHost;
}

describe("MessageDetailPage in PluginHostProvider", () => {
  afterEach(() => {
    cleanup();
    window.history.pushState({}, "", "/");
  });

  it("renders conversation body when peer is in scope", async () => {
    const peer = "02aaaa".padEnd(66, "a");
    const sample: AppMsgMessage = {
      messageId: "id-detail-1",
      clientMessageId: "c-detail-1",
      senderPublicKeyHex: peer,
      senderAppId: "keymaster.message",
      recipientPublicKeyHex: OWNER,
      recipientAppId: "keymaster.message",
      contentType: "text/plain",
      body: "detail body text",
      createdAtMs: 1000,
      insertedAtMs: 2000
    };
    const service = makeFakeService({ messages: [sample] });
    const host = makeFakeHost(service);
    const { MessageDetailPage } = await import("./MessageDetailPage.js");
    window.history.pushState({}, "", `/messages/${peer}`);
    render(
      <PluginHostProvider host={host}>
        <MessageDetailPage />
      </PluginHostProvider>
    );
    await waitFor(() => {
      expect(screen.getByText("detail body text")).toBeTruthy();
    });
    await waitFor(() => {
      expect(screen.getAllByText("02aa...aaaa").length).toBeGreaterThan(0);
    });
  });

  it("accepts the singular /message/:publicKeyHex route", async () => {
    const peer = "02cccc".padEnd(66, "c");
    const sample: AppMsgMessage = {
      messageId: "id-detail-alias-1",
      clientMessageId: "c-detail-alias-1",
      senderPublicKeyHex: peer,
      senderAppId: "keymaster.message",
      recipientPublicKeyHex: OWNER,
      recipientAppId: "keymaster.message",
      contentType: "text/plain",
      body: "alias route body",
      createdAtMs: 1000,
      insertedAtMs: 2000
    };
    const service = makeFakeService({ messages: [sample] });
    const host = makeFakeHost(service, makeFakeWebrtcService());
    const { MessageDetailPage } = await import("./MessageDetailPage.js");
    window.history.pushState({}, "", `/message/${peer}`);
    render(
      <PluginHostProvider host={host}>
        <MessageDetailPage />
      </PluginHostProvider>
    );

    await waitFor(() => {
      expect(screen.getByLabelText("message.page.detail.body")).toBeTruthy();
      expect(screen.getByText("message.page.send.submit")).toBeTruthy();
      expect(screen.getByText("message.page.detail.video")).toBeTruthy();
      expect(screen.getByText("message.page.detail.audio")).toBeTruthy();
    });
  });

  it("renders the video call panel for the current peer and binds both video streams", async () => {
    const peer = "02dddd".padEnd(66, "d");
    const attachCalls: Array<{ direction: "local" | "remote"; videoEl: HTMLVideoElement }> = [];
    const webrtc = makeFakeWebrtcService({
      snapshot: {
        phase: "connected",
        remotePublicKeyHex: peer,
        direction: "outgoing",
        mode: "video",
        hasLocalStream: true,
        hasRemoteStream: true,
        remoteNotice: null,
        serviceReady: true,
        lastError: null
      },
      attachToVideo: (direction, videoEl) => {
        attachCalls.push({ direction, videoEl });
      }
    });
    const host = makeFakeHost(makeFakeService({ messages: [] }), webrtc);
    const { MessageDetailPage } = await import("./MessageDetailPage.js");
    window.history.pushState({}, "", `/message/${peer}`);
    render(
      <PluginHostProvider host={host}>
        <MessageDetailPage />
      </PluginHostProvider>
    );

    await waitFor(() => {
      expect(screen.getByText("message.page.detail.call.title.video")).toBeTruthy();
      expect(screen.getByText("message.page.detail.call.swap")).toBeTruthy();
      expect(screen.getByText("message.page.detail.call.fullscreen")).toBeTruthy();
    });
    expect(attachCalls.map((item) => item.direction)).toEqual(["local", "remote"]);
  });

  it("shows the call panel after startCall emits an outgoing snapshot", async () => {
    const peer = "02efef".padEnd(66, "e");
    const routedPeer = peer.toUpperCase();
    const webrtc = makeFakeWebrtcService({
      snapshot: {
        phase: "idle",
        remotePublicKeyHex: null,
        direction: null,
        mode: null,
        hasLocalStream: false,
        hasRemoteStream: false,
        remoteNotice: null,
        serviceReady: true,
        lastError: null
      },
      startCallSnapshot: {
        phase: "inviting",
        remotePublicKeyHex: peer,
        direction: "outgoing",
        mode: "video",
        hasLocalStream: true,
        hasRemoteStream: false,
        remoteNotice: null,
        serviceReady: true,
        lastError: null
      }
    });
    const host = makeFakeHost(makeFakeService({ messages: [] }), webrtc);
    const { MessageDetailPage } = await import("./MessageDetailPage.js");
    window.history.pushState({}, "", `/message/${routedPeer}`);
    render(
      <PluginHostProvider host={host}>
        <MessageDetailPage />
      </PluginHostProvider>
    );

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "message.page.detail.video" })).toBeTruthy();
    });
    fireEvent.click(screen.getByRole("button", { name: "message.page.detail.video" }));
    await waitFor(() => {
      expect(screen.getByText("message.page.detail.call.title.video")).toBeTruthy();
      expect(screen.getByRole("button", { name: "message.page.detail.call.hangup" })).toBeTruthy();
    });
    expect(document.querySelector('[data-call-phase="inviting"]')).toBeTruthy();
  });

  it("renders the audio call panel for the current peer and exposes call controls", async () => {
    const peer = "02eeee".padEnd(66, "e");
    const webrtc = makeFakeWebrtcService({
      snapshot: {
        phase: "incoming",
        remotePublicKeyHex: peer,
        direction: "incoming",
        mode: "audio",
        hasLocalStream: true,
        hasRemoteStream: false,
        remoteNotice: null,
        serviceReady: true,
        lastError: null
      }
    });
    const host = makeFakeHost(makeFakeService({ messages: [] }), webrtc);
    const { MessageDetailPage } = await import("./MessageDetailPage.js");
    window.history.pushState({}, "", `/messages/${peer}`);
    render(
      <PluginHostProvider host={host}>
        <MessageDetailPage />
      </PluginHostProvider>
    );

    await waitFor(() => {
      expect(screen.getByText("message.page.detail.call.title.audio")).toBeTruthy();
      expect(screen.getByText("message.page.detail.call.accept")).toBeTruthy();
      expect(screen.getByText("message.page.detail.call.reject")).toBeTruthy();
    });
    expect(screen.queryByText("message.page.detail.call.swap")).toBeNull();
    expect(screen.queryByText("message.page.detail.call.fullscreen")).toBeNull();
  });

  it("disables start-call buttons when another peer already owns the active session", async () => {
    const peer = "02abab".padEnd(66, "a");
    const otherPeer = "02bcbc".padEnd(66, "b");
    const webrtc = makeFakeWebrtcService({
      snapshot: {
        phase: "connecting",
        remotePublicKeyHex: otherPeer,
        direction: "outgoing",
        mode: "video",
        hasLocalStream: true,
        hasRemoteStream: false,
        remoteNotice: null,
        serviceReady: true,
        lastError: null
      }
    });
    const host = makeFakeHost(makeFakeService({ messages: [] }), webrtc);
    const { MessageDetailPage } = await import("./MessageDetailPage.js");
    window.history.pushState({}, "", `/message/${peer}`);
    render(
      <PluginHostProvider host={host}>
        <MessageDetailPage />
      </PluginHostProvider>
    );

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "message.page.detail.video" })).toBeTruthy();
      expect(screen.getByRole("button", { name: "message.page.detail.audio" })).toBeTruthy();
    });
    expect((screen.getByRole("button", { name: "message.page.detail.video" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "message.page.detail.audio" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("renders newest messages closer to the composer", async () => {
    const peer = "02eeee".padEnd(66, "e");
    const older: AppMsgMessage = {
      messageId: "id-detail-old",
      clientMessageId: "c-detail-old",
      senderPublicKeyHex: peer,
      senderAppId: "keymaster.message",
      recipientPublicKeyHex: OWNER,
      recipientAppId: "keymaster.message",
      contentType: "text/plain",
      body: "older message",
      createdAtMs: 1000,
      insertedAtMs: 1000
    };
    const newer: AppMsgMessage = {
      messageId: "id-detail-new",
      clientMessageId: "c-detail-new",
      senderPublicKeyHex: OWNER,
      senderAppId: "keymaster.message",
      recipientPublicKeyHex: peer,
      recipientAppId: "keymaster.message",
      contentType: "text/plain",
      body: "newer message",
      createdAtMs: 2000,
      insertedAtMs: 2000
    };
    const service = makeFakeService({ messages: [older, newer] });
    const host = makeFakeHost(service);
    const { MessageDetailPage } = await import("./MessageDetailPage.js");
    window.history.pushState({}, "", `/messages/${peer}`);
    render(
      <PluginHostProvider host={host}>
        <MessageDetailPage />
      </PluginHostProvider>
    );
    await waitFor(() => {
      expect(screen.getByText("older message")).toBeTruthy();
      expect(screen.getByText("newer message")).toBeTruthy();
    });
    const bodies = screen.getAllByText(/message$/);
    expect(bodies[0]?.textContent).toBe("newer message");
    expect(bodies[1]?.textContent).toBe("older message");
  });

  it("renders timeline labels through i18n keys", async () => {
    const peer = "02abab".padEnd(66, "a");
    const messages: AppMsgMessage[] = [{
      messageId: "id-timeline-text",
      clientMessageId: "c-timeline-text",
      senderPublicKeyHex: OWNER,
      senderAppId: "keymaster.message",
      recipientPublicKeyHex: peer,
      recipientAppId: "keymaster.message",
      contentType: "text/plain",
      body: "timeline body",
      createdAtMs: 1000,
      insertedAtMs: 1000
    }];
    const history: WebrtcHistoryItem[] = [
      {
        recordId: "call-1",
        ownerPublicKeyHex: OWNER,
        peerPublicKeyHex: peer,
        kind: "audio_call",
        direction: "outgoing",
        status: "completed",
        startedAtMs: 2000,
        endedAtMs: 3000,
        durationSec: 1,
        itemType: "call"
      },
      {
        recordId: "file-1",
        ownerPublicKeyHex: OWNER,
        peerPublicKeyHex: peer,
        kind: "file",
        direction: "outgoing",
        status: "completed",
        startedAtMs: 4000,
        endedAtMs: 5000,
        durationSec: 1,
        fileName: "report.pdf",
        mimeType: "application/pdf",
        byteLength: 42,
        blobKey: "blob-1",
        itemType: "transfer"
      }
    ];
    const service = makeFakeService({ messages });
    const webrtc = makeFakeWebrtcService({ history });
    const host = makeFakeHost(service, webrtc);
    const { MessageDetailPage } = await import("./MessageDetailPage.js");
    window.history.pushState({}, "", `/messages/${peer}`);
    render(
      <PluginHostProvider host={host}>
        <MessageDetailPage />
      </PluginHostProvider>
    );
    await waitFor(() => {
      expect(screen.getByText("message.page.detail.from.me")).toBeTruthy();
      expect(screen.getByText("message.page.detail.timeline.call.audio")).toBeTruthy();
      expect(
        screen.getAllByText((_, element) =>
          element?.textContent?.includes("message.page.detail.timeline.call.outgoing") ?? false
        ).length
      ).toBeGreaterThan(0);
      expect(
        screen.getAllByText((_, element) =>
          element?.textContent?.includes("message.page.detail.timeline.call.status.completed") ?? false
        ).length
      ).toBeGreaterThan(0);
      expect(screen.getByText("message.page.detail.timeline.download")).toBeTruthy();
    });
  });

  it("aligns outgoing and incoming attachments by direction", async () => {
    const peer = "02adad".padEnd(66, "d");
    const service = makeFakeService({ messages: [] });
    const webrtc = makeFakeWebrtcService({
      history: [
        {
          recordId: "image-outgoing",
          ownerPublicKeyHex: OWNER,
          peerPublicKeyHex: peer,
          kind: "image",
          direction: "outgoing",
          status: "completed",
          startedAtMs: 1000,
          endedAtMs: 2000,
          durationSec: 1,
          fileName: "outgoing.png",
          mimeType: "image/png",
          byteLength: 128,
          blobKey: "blob-outgoing",
          itemType: "transfer"
        },
        {
          recordId: "file-incoming",
          ownerPublicKeyHex: OWNER,
          peerPublicKeyHex: peer,
          kind: "file",
          direction: "incoming",
          status: "completed",
          startedAtMs: 3000,
          endedAtMs: 4000,
          durationSec: 1,
          fileName: "incoming.pdf",
          mimeType: "application/pdf",
          byteLength: 2048,
          blobKey: "blob-incoming",
          itemType: "transfer"
        }
      ]
    });
    const host = makeFakeHost(service, webrtc);
    const { MessageDetailPage } = await import("./MessageDetailPage.js");
    window.history.pushState({}, "", `/messages/${peer}`);
    render(
      <PluginHostProvider host={host}>
        <MessageDetailPage />
      </PluginHostProvider>
    );

    await waitFor(() => {
      expect(screen.getByText("outgoing.png")).toBeTruthy();
      expect(screen.getAllByText("incoming.pdf").length).toBeGreaterThan(0);
    });

    const outgoingAttachment = screen.getByText("outgoing.png").closest(".km-message-detail__attachment");
    const incomingAttachment = screen.getByText((content, element) =>
      element?.classList.contains("km-message-detail__system-line") ? content === "incoming.pdf" : false
    ).closest(".km-message-detail__attachment");

    expect(outgoingAttachment?.className.includes("is-me")).toBe(true);
    expect(incomingAttachment?.className.includes("is-peer")).toBe(true);
  });

  it("aligns outgoing and incoming call records by direction", async () => {
    const peer = "02acac".padEnd(66, "c");
    const service = makeFakeService({ messages: [] });
    const webrtc = makeFakeWebrtcService({
      history: [
        {
          recordId: "call-outgoing",
          ownerPublicKeyHex: OWNER,
          peerPublicKeyHex: peer,
          kind: "video_call",
          direction: "outgoing",
          status: "completed",
          startedAtMs: 1000,
          endedAtMs: 2000,
          durationSec: 1,
          itemType: "call"
        },
        {
          recordId: "call-incoming",
          ownerPublicKeyHex: OWNER,
          peerPublicKeyHex: peer,
          kind: "audio_call",
          direction: "incoming",
          status: "missed",
          startedAtMs: 3000,
          endedAtMs: 4000,
          durationSec: 1,
          itemType: "call"
        }
      ]
    });
    const host = makeFakeHost(service, webrtc);
    const { MessageDetailPage } = await import("./MessageDetailPage.js");
    window.history.pushState({}, "", `/messages/${peer}`);
    render(
      <PluginHostProvider host={host}>
        <MessageDetailPage />
      </PluginHostProvider>
    );

    await waitFor(() => {
      expect(screen.getAllByText("message.page.detail.timeline.call.video").length).toBeGreaterThan(0);
      expect(screen.getAllByText("message.page.detail.timeline.call.audio").length).toBeGreaterThan(0);
    });

    const outgoingCall = screen.getAllByText((_, element) =>
      element?.classList.contains("km-message-detail__system-line")
        ? element.textContent?.includes("message.page.detail.timeline.call.outgoing") ?? false
        : false
    )[0]?.closest(".km-message-detail__system");
    const incomingCall = screen.getAllByText((_, element) =>
      element?.classList.contains("km-message-detail__system-line")
        ? element.textContent?.includes("message.page.detail.timeline.call.incoming") ?? false
        : false
    )[0]?.closest(".km-message-detail__system");

    expect(outgoingCall?.className.includes("is-me")).toBe(true);
    expect(incomingCall?.className.includes("is-peer")).toBe(true);
  });

  it("maps attachment failures to localized error keys", async () => {
    const peer = "02acac".padEnd(66, "a");
    const service = makeFakeService({ messages: [] });
    const webrtc = makeFakeWebrtcService({
      sendImage: async () => {
        throw new Error("transfer_too_large");
      }
    });
    const host = makeFakeHost(service, webrtc);
    const { MessageDetailPage } = await import("./MessageDetailPage.js");
    window.history.pushState({}, "", `/messages/${peer}`);
    render(
      <PluginHostProvider host={host}>
        <MessageDetailPage />
      </PluginHostProvider>
    );
    await waitFor(() => {
      expect(screen.getByText("message.page.detail.online")).toBeTruthy();
    });
    const input = await screen.findByLabelText("message.page.detail.body");
    expect(input).toBeTruthy();
    const fileInput = document.querySelector('input[type="file"][accept="image/*"]') as HTMLInputElement | null;
    expect(fileInput).toBeTruthy();
    fireEvent.change(fileInput!, {
      target: { files: [new File([new Uint8Array([1, 2, 3])], "a.png", { type: "image/png" })] }
    });
    await waitFor(() => {
      expect(screen.getByText("message.page.detail.error.transfer_too_large")).toBeTruthy();
    });
  });

  it("maps raw transfer timeout failures to localized error keys", async () => {
    const peer = "02adad".padEnd(66, "a");
    const service = makeFakeService({ messages: [] });
    const webrtc = makeFakeWebrtcService({
      sendImage: async () => {
        throw new Error("transfer_timeout");
      }
    });
    const host = makeFakeHost(service, webrtc);
    const { MessageDetailPage } = await import("./MessageDetailPage.js");
    window.history.pushState({}, "", `/messages/${peer}`);
    render(
      <PluginHostProvider host={host}>
        <MessageDetailPage />
      </PluginHostProvider>
    );
    await waitFor(() => {
      expect(screen.getByText("message.page.detail.online")).toBeTruthy();
    });
    const fileInput = document.querySelector('input[type="file"][accept="image/*"]') as HTMLInputElement | null;
    expect(fileInput).toBeTruthy();
    fireEvent.change(fileInput!, {
      target: { files: [new File([new Uint8Array([1, 2, 3])], "a.png", { type: "image/png" })] }
    });
    await waitFor(() => {
      expect(screen.getByText("message.page.detail.error.transfer_timeout")).toBeTruthy();
    });
  });

  it("maps missing local blob failures to localized error keys", async () => {
    const peer = "02aeae".padEnd(66, "a");
    const service = makeFakeService({ messages: [] });
    const webrtc = makeFakeWebrtcService({
      history: [
        {
          recordId: "file-local-blob",
          ownerPublicKeyHex: OWNER,
          peerPublicKeyHex: peer,
          kind: "file",
          direction: "outgoing",
          status: "completed",
          startedAtMs: 1000,
          endedAtMs: 2000,
          durationSec: 1,
          fileName: "report.pdf",
          mimeType: "application/pdf",
          byteLength: 42,
          blobKey: "blob-local-blob",
          itemType: "transfer"
        }
      ]
    });
    const host = makeFakeHost(service, webrtc);
    const { MessageDetailPage } = await import("./MessageDetailPage.js");
    window.history.pushState({}, "", `/messages/${peer}`);
    render(
      <PluginHostProvider host={host}>
        <MessageDetailPage />
      </PluginHostProvider>
    );
    await waitFor(() => {
      expect(screen.getByText("message.page.detail.online")).toBeTruthy();
    });
    const downloadButton = await screen.findByRole("button", { name: "message.page.detail.timeline.download" });
    fireEvent.click(downloadButton);
    await waitFor(() => {
      expect(screen.getByText("message.page.detail.error.local_blob_unavailable")).toBeTruthy();
    });
  });

  it("shows 20 messages by default and loads 20 more on demand", async () => {
    const peer = "02ffff".padEnd(66, "f");
    const messages: AppMsgMessage[] = Array.from({ length: 25 }, (_, index) => ({
      messageId: `id-${index}`,
      clientMessageId: `c-${index}`,
      senderPublicKeyHex: index % 2 === 0 ? OWNER : peer,
      senderAppId: "keymaster.message",
      recipientPublicKeyHex: index % 2 === 0 ? peer : OWNER,
      recipientAppId: "keymaster.message",
      contentType: "text/plain",
      body: `message-${index}`,
      createdAtMs: index + 1,
      insertedAtMs: index + 1
    }));
    const service = makeFakeService({ messages });
    const host = makeFakeHost(service);
    const { MessageDetailPage } = await import("./MessageDetailPage.js");
    window.history.pushState({}, "", `/messages/${peer}`);
    render(
      <PluginHostProvider host={host}>
        <MessageDetailPage />
      </PluginHostProvider>
    );
    await waitFor(() => {
      expect(screen.getByText("message-24")).toBeTruthy();
    });
    expect(screen.getByText("message-5")).toBeTruthy();
    expect(screen.queryByText("message-4")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "message.page.detail.loadMore" }));
    await waitFor(() => {
      expect(screen.getByText("message-4")).toBeTruthy();
    });
  });

  it("renders empty state when peer conversation is empty", async () => {
    const peer = "02cccc".padEnd(66, "c");
    const service = makeFakeService({ messages: [] });
    const host = makeFakeHost(service);
    const { MessageDetailPage } = await import("./MessageDetailPage.js");
    window.history.pushState({}, "", `/messages/${peer}`);
    render(
      <PluginHostProvider host={host}>
        <MessageDetailPage />
      </PluginHostProvider>
    );
    await waitFor(() => {
      expect(screen.getByText("message.page.detail.empty")).toBeTruthy();
    });
  });

  it("loads a larger message window for older conversations", async () => {
    const peer = "02dddd".padEnd(66, "d");
    const seenLimits: number[] = [];
    const sample: AppMsgMessage = {
      messageId: "id-detail-window",
      clientMessageId: "c-detail-window",
      senderPublicKeyHex: peer,
      senderAppId: "keymaster.message",
      recipientPublicKeyHex: OWNER,
      recipientAppId: "keymaster.message",
      contentType: "text/plain",
      body: "older conversation body",
      createdAtMs: 1000,
      insertedAtMs: 2000
    };
    const service = makeFakeService({
      messages: [sample],
      onListMessages: (input) => {
        seenLimits.push(input?.limit ?? 0);
      }
    });
    const host = makeFakeHost(service);
    const { MessageDetailPage } = await import("./MessageDetailPage.js");
    window.history.pushState({}, "", `/messages/${peer}`);
    render(
      <PluginHostProvider host={host}>
        <MessageDetailPage />
      </PluginHostProvider>
    );
    await waitFor(() => {
      expect(screen.getByText("older conversation body")).toBeTruthy();
    });
    expect(seenLimits.some((limit) => limit >= 10_000)).toBe(true);
  });

  it("renders missing-service empty state when capability is missing (唯一降级路径)", async () => {
    const host = makeFakeHost(null);
    const { MessageDetailPage } = await import("./MessageDetailPage.js");
    window.history.pushState({}, "", "/messages/any");
    render(
      <PluginHostProvider host={host}>
        <MessageDetailPage />
      </PluginHostProvider>
    );
    await waitFor(() => {
      expect(screen.getByText("message.page.noClient")).toBeTruthy();
    });
  });

  it("does NOT render sync / connection / global stat UI", async () => {
    const service = makeFakeService({ messages: [] });
    const host = makeFakeHost(service);
    const { MessageDetailPage } = await import("./MessageDetailPage.js");
    window.history.pushState({}, "", "/messages/x");
    render(
      <PluginHostProvider host={host}>
        <MessageDetailPage />
      </PluginHostProvider>
    );
    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "x" })).toBeTruthy();
    });
    expect(screen.queryByText("message.page.sync.state.label")).toBeNull();
    expect(screen.queryByText("message.page.online.label")).toBeNull();
    expect(screen.queryByText("message.page.list.label")).toBeNull();
  });
});

void vi;
