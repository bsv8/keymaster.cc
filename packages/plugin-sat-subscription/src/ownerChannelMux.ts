import type { ChannelSubscriptionStatus, SessionEpoch } from "@keymaster/contracts";
import { inboxChannel, parsePublicKey } from "bsv8-channel-protocol";
import { ChannelSubscriptionMux, type ChannelSubscriptionDriver } from "./channelSubscriptionMux.js";
export interface OwnerChannelMuxDependencies {
  ownerPublicKeyHex: string;
  sessionEpoch: SessionEpoch;
  signal: AbortSignal;
  driver: ChannelSubscriptionDriver;
  assertFresh(mux?: ChannelSubscriptionMux): void;
  created(mux: ChannelSubscriptionMux, offStatus: () => void): void;
  released(mux: ChannelSubscriptionMux): void;
  status(status: ChannelSubscriptionStatus): void;
}

/** Sat owns initial inbox subscription and cleanup of an unpublished or stale candidate. */
export async function createOwnerChannelMux(deps: OwnerChannelMuxDependencies): Promise<ChannelSubscriptionMux> {
  deps.assertFresh();
  const mux = new ChannelSubscriptionMux({ driver: deps.driver });
  const offStatus = mux.subscribeSubscriptionStatus(deps.status);
  try {
    deps.created(mux, offStatus);
    const ownerInbox = inboxChannel(parsePublicKey(deps.ownerPublicKeyHex));
    try {
      await mux.set(`${deps.sessionEpoch}:system:owner-inbox`, [ownerInbox], deps.signal);
    } catch (error) {
      // Retain the intent when the receive supplier is temporarily unavailable.
      console.warn("[channel] owner inbox subscription unavailable", error instanceof Error ? error.message : String(error));
    }
    deps.assertFresh(mux);
    return mux;
  } catch (error) {
    offStatus();
    try { await mux.clear().catch(() => undefined); }
    finally { mux.dispose(); deps.released(mux); }
    throw error;
  }
}
