import { parseP2pkhProtocolCommandResult, type bindWalletIdentity, type P2pkhCoordinatorControl, type P2pkhProtocolCommand, type ProtocolSpendPrepareInput, type ProtocolSpendPreview, type ProtocolSpendService } from "@keymaster/contracts";

/** Wallet assembly owns the identity binding; business callers submit only plans. */
export function createWindowProtocolSpend(
  coordinator: Pick<P2pkhCoordinatorControl, "p2pkhProtocolCommand">,
  wallet: ReturnType<typeof bindWalletIdentity>,
) {
  wallet.assertActive();
  const identity = { ownerPublicKeyHex: wallet.identity.publicKeyHex, network: wallet.identity.bsvNetwork };
  const bind = <T extends object>(input: T) => {
    wallet.assertActive();
    for (const key of ["ownerPublicKeyHex", "network", "networkIdentity", "bsvNetwork"]) {
      if (key in input) throw new TypeError(`Protocol requests do not accept ${key}`);
    }
    return { ...structuredClone(input), ...identity };
  };
  const assertPreview = (preview: ProtocolSpendPreview) => {
    wallet.assertActive();
    if (preview.ownerPublicKeyHex.toLowerCase() !== identity.ownerPublicKeyHex || preview.network !== identity.network) throw new Error("Protocol preview identity mismatch");
  };
  async function call(command: P2pkhProtocolCommand) {
    wallet.assertActive();
    const result = await coordinator.p2pkhProtocolCommand(structuredClone(command));
    wallet.assertActive();
    if (result.status !== "ok") throw new Error("message" in result ? result.message : `Protocol RPC failed: ${result.status}`);
    const value = parseP2pkhProtocolCommandResult(result.value);
    if (value.type !== command.type) throw new Error("Protocol RPC response type changed");
    return value;
  }
  async function preview(type: "prepare" | "presign", input: ProtocolSpendPrepareInput) {
    const result = await call({ type, input: bind(input) });
    if (result.type !== "prepare" && result.type !== "presign") throw new Error("Protocol RPC preview missing");
    assertPreview(result.value);
    return result.value;
  }
  const service: ProtocolSpendService = {
    prepare: input => preview("prepare", input),
    presign: input => preview("presign", input),
    async submit(input) {
      assertPreview(input);
      const result = await call({ type: "submit", input });
      if (result.type !== "submit") throw new Error("Protocol RPC submit result missing");
      return result.value;
    },
    async releasePrepared(input) { assertPreview(input); await call({ type: "release", input }); },
    async releasePreparedSubmission(input) { await call({ type: "release-submission", input: bind(input) }); },
  };
  return Object.assign(service, {
    async planFunding(input: Omit<Extract<P2pkhProtocolCommand, { type: "funding-plan" }>["input"], "ownerPublicKeyHex" | "network">) {
      const result = await call({ type: "funding-plan", input: bind(input) });
      if (result.type !== "funding-plan") throw new Error("Protocol RPC funding plan missing");
      return result.value;
    },
  });
}
