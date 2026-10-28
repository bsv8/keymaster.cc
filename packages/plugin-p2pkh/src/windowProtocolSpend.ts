import type { bindWalletIdentity, P2pkhCoordinatorControl, P2pkhProtocolCommand, P2pkhProtocolResultFor, ProtocolSpendPrepareInput, ProtocolSpendService } from "@keymaster/contracts";

/** Wallet assembly owns identity; internal callers and Worker results are trusted. */
export function createWindowProtocolSpend(
  coordinator: Pick<P2pkhCoordinatorControl, "p2pkhProtocolCommand">,
  wallet: ReturnType<typeof bindWalletIdentity>,
) {
  wallet.assertActive();
  const identity = { ownerPublicKeyHex: wallet.identity.publicKeyHex, network: wallet.identity.bsvNetwork };
  const bind = <T extends object>(input: T) => {
    wallet.assertActive();
    return { ...structuredClone(input), ...identity };
  };
  async function call<T extends P2pkhProtocolCommand["type"]>(command: P2pkhProtocolCommand & { type: T }): Promise<P2pkhProtocolResultFor<T>["value"]> {
    wallet.assertActive();
    const result = await coordinator.p2pkhProtocolCommand(structuredClone(command));
    wallet.assertActive();
    if (result.status !== "ok") throw new Error("message" in result ? result.message : `Protocol RPC failed: ${result.status}`);
    return result.value.value as P2pkhProtocolResultFor<T>["value"];
  }
  const preview = async (type: "prepare" | "presign", input: ProtocolSpendPrepareInput) => call({ type, input: bind(input) });
  const service: ProtocolSpendService = {
    prepare: input => preview("prepare", input),
    presign: input => preview("presign", input),
    submit: input => call({ type: "submit", input }),
    async releasePrepared(input) { await call({ type: "release", input }); },
    async releasePreparedSubmission(input) { await call({ type: "release-submission", input: bind(input) }); },
  };
  return Object.assign(service, {
    async planFunding(input: Omit<Extract<P2pkhProtocolCommand, { type: "funding-plan" }>["input"], "ownerPublicKeyHex" | "network">) {
      return call({ type: "funding-plan", input: bind(input) });
    },
  });
}
