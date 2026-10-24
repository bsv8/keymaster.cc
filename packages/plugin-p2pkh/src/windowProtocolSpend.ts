import { parseP2pkhProtocolCommandResult, type P2pkhCoordinatorControl, type P2pkhProtocolCommand, type ProtocolSpendPrepareInput, type ProtocolSpendService } from "@keymaster/contracts";

/** Preserve the existing plugin capability, but never keep a signer, claims,
 * preview tickets or a second authority in Window. No legacy local fallback. */
export function createWindowProtocolSpend(coordinator: Pick<P2pkhCoordinatorControl, "p2pkhProtocolCommand">) {
  async function call(command: P2pkhProtocolCommand) {
    const result = await coordinator.p2pkhProtocolCommand(structuredClone(command));
    if (result.status !== "ok") throw new Error("message" in result ? result.message : `Protocol RPC failed: ${result.status}`);
    const value = parseP2pkhProtocolCommandResult(result.value);
    if (value.type !== command.type) throw new Error("Protocol RPC response type changed");
    return value;
  }
  async function preview(type: "prepare" | "presign", input: ProtocolSpendPrepareInput) {
    const result = await call({ type, input });
    if (result.type !== "prepare" && result.type !== "presign") throw new Error("Protocol RPC preview missing");
    return result.value;
  }
  const service: ProtocolSpendService = {
    prepare: input => preview("prepare", input),
    presign: input => preview("presign", input),
    async submit(input) {
      const result = await call({ type: "submit", input });
      if (result.type !== "submit") throw new Error("Protocol RPC submit result missing");
      return result.value;
    },
    async releasePrepared(input) { await call({ type: "release", input }); },
    async releasePreparedSubmission(input) { await call({ type: "release-submission", input }); },
  };
  return Object.assign(service, {
    async planFunding(input: Extract<P2pkhProtocolCommand, { type: "funding-plan" }>["input"]) {
      const result = await call({ type: "funding-plan", input });
      if (result.type !== "funding-plan") throw new Error("Protocol RPC funding plan missing");
      return result.value;
    },
  });
}
