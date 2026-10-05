import type { ContactsPresenceChannel } from "@keymaster/contracts";
export interface ContactsPresenceChannelDependencies extends ContactsPresenceChannel {
  assertActive(): void;
  owner(): string | undefined;
}

/** The presence lane only subscribes the current owner's inbox and publishes Ping/Pong. */
export function createContactsPresenceChannel(deps: ContactsPresenceChannelDependencies): ContactsPresenceChannel {
  return Object.freeze({
    isReady() { deps.assertActive(); return deps.isReady(); },
    async publishPrivate(input, signal) {
      deps.assertActive();
      if (input.protocol !== "bsv8.ping.v1") throw new Error("Contacts presence only supports Ping/Pong");
      const result = await deps.publishPrivate(input, signal);
      deps.assertActive();
      return result;
    },
    async subscriptionSet(channels, signal) {
      deps.assertActive();
      const owner = deps.owner();
      if (!owner || channels.some(channel => channel !== `bsv8.inbox.${owner}`)) throw new Error("Contacts presence only subscribes the owner inbox");
      const result = await deps.subscriptionSet(channels, signal);
      deps.assertActive();
      return result;
    },
  });
}
