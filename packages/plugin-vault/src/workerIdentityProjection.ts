import type { KeyIdentity } from "@keymaster/contracts";
/** Worker-private public metadata, committed together with the Vault session. */
export function createWorkerIdentityProjection() {
  let summary: KeyIdentity | undefined;
  const clone = (value: KeyIdentity): KeyIdentity => ({ ...value, capabilities: [...value.capabilities] });
  return { summary: () => summary === undefined ? undefined : clone(summary),
    setSummary(value: KeyIdentity | undefined) { summary = value === undefined ? undefined : clone(value); } };
}
