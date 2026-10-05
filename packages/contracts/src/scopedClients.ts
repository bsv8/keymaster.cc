import { defineCapability, type PluginConsumer, type LifecycleScope } from "webloom-framework";
import type { BorrowedKeyValueStore } from "./storage/kv.js";
import type { BorrowedOwnerFileStore } from "./storage/files.js";
import type { StorageCoordinatorControl, VaultCoordinatorControl, BackgroundCoordinatorControl, P2pkhCoordinatorControl, MsFileCoordinatorControl, SatCoordinatorControl, WindowP2pCoordinatorControl, ProtocolCoordinatorControl, ContactsCoordinatorControl } from "./sessionCoordinator.js";
/** Transport binding is assembly plumbing, not authority to impersonate another plugin. */
export interface CoordinatorClientBinding<T> { bind(consumer: PluginConsumer, scope: LifecycleScope): T }
export interface PluginFileClients { bind(consumer: PluginConsumer, scope: LifecycleScope, purposeId: string): BorrowedOwnerFileStore }
export interface PluginKeyValueClients { bind(consumer: PluginConsumer, scope: LifecycleScope, purposeId: string): BorrowedKeyValueStore }
export const STORAGE_FILE_CLIENTS_CAPABILITY = defineCapability<PluginFileClients>({ kind: "local", id: "storage.file-clients", version: "1" });
export const STORAGE_KV_CLIENTS_CAPABILITY = defineCapability<PluginKeyValueClients>({ kind: "local", id: "storage.kv-clients", version: "1" });
export const STORAGE_COORDINATOR_CLIENT_BINDING_CAPABILITY = defineCapability<CoordinatorClientBinding<StorageCoordinatorControl>>({ kind: "local", id: "storage.coordinator-client-binding", version: "1" });
export const VAULT_COORDINATOR_CLIENT_BINDING_CAPABILITY = defineCapability<CoordinatorClientBinding<VaultCoordinatorControl>>({ kind: "local", id: "vault.coordinator-client-binding", version: "1" });
export const BACKGROUND_COORDINATOR_CLIENT_BINDING_CAPABILITY = defineCapability<CoordinatorClientBinding<BackgroundCoordinatorControl>>({ kind: "local", id: "background.coordinator-client-binding", version: "1" });
export const P2PKH_COORDINATOR_CLIENT_BINDING_CAPABILITY = defineCapability<CoordinatorClientBinding<P2pkhCoordinatorControl>>({ kind: "local", id: "p2pkh.coordinator-client-binding", version: "1" });
export const WOC_COORDINATOR_CLIENT_BINDING_CAPABILITY = defineCapability<CoordinatorClientBinding<P2pkhCoordinatorControl>>({ kind: "local", id: "woc.coordinator-client-binding", version: "1" });
export const MSFILE_COORDINATOR_CLIENT_BINDING_CAPABILITY = defineCapability<CoordinatorClientBinding<MsFileCoordinatorControl>>({ kind: "local", id: "msfile.coordinator-client-binding", version: "1" });
export const SAT_COORDINATOR_CLIENT_BINDING_CAPABILITY = defineCapability<CoordinatorClientBinding<SatCoordinatorControl>>({ kind: "local", id: "sat-subscription.coordinator-client-binding", version: "1" });
export const WINDOW_P2P_COORDINATOR_CLIENT_BINDING_CAPABILITY = defineCapability<CoordinatorClientBinding<WindowP2pCoordinatorControl>>({ kind: "local", id: "window-p2p.coordinator-client-binding", version: "1" });
export const PROTOCOL_COORDINATOR_CLIENT_BINDING_CAPABILITY = defineCapability<CoordinatorClientBinding<ProtocolCoordinatorControl>>({ kind: "local", id: "protocol.coordinator-client-binding", version: "1" });
export const CONTACTS_COORDINATOR_CLIENT_BINDING_CAPABILITY = defineCapability<CoordinatorClientBinding<ContactsCoordinatorControl>>({ kind: "local", id: "contacts.coordinator-client-binding", version: "1" });
