import { VAULT_WALLET_STATE_CAPABILITY, type VaultWalletState, type VaultWalletStateAccess, type VaultService } from "./vault.js";
import type { PluginConsumer, LifecycleScope } from "webloom-framework";
declare const view: VaultWalletState;
declare const access: VaultWalletStateAccess;
declare const vault: VaultService;
declare const consumer: PluginConsumer;
declare const scope: LifecycleScope;
access.bind(consumer, scope).snapshot();
// @ts-expect-error caller cannot bind by plugin id
access.bind("p2pkh", scope);
// @ts-expect-error a view cannot rebind or acquire a provider
view.bind(consumer, scope);
// @ts-expect-error read-only state does not expose a signer
view.createActiveKeyCrypto("key");
// @ts-expect-error old Keyspace current-key method was deleted
view.requireActiveKey();
// @ts-expect-error public Vault management has no duplicate state reader
vault.getLifecycleSnapshot();
// @ts-expect-error public Vault management has no duplicate state subscription
vault.onLifecycleChange(() => {});
// @ts-expect-error old Keyspace capability no longer exists
import { KEYSPACE_SERVICE_CAPABILITY } from "./index.js";
void VAULT_WALLET_STATE_CAPABILITY;
