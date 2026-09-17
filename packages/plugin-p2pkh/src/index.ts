// packages/plugin-p2pkh/src/index.ts
export { p2pkhPlugin, p2pkhSetup } from "./manifest.js";
export { P2PKH_CAPABILITY } from "./p2pkhContracts.js";
export { openP2pkhStateRepository, createP2pkhStateRepository } from "./storage/p2pkhStateRepository.js";
export { createP2pkhFileRepository } from "./storage/p2pkhFileRepository.js";
export type { P2pkhFileRepositoryHandle, P2pkhHeightEntry, P2pkhFileLoadResult } from "./storage/p2pkhFileRepository.js";
export { createP2pkhChainStore } from "./storage/p2pkhChainStore.js";
export type { P2pkhChainStoreHandle, P2pkhChainSnapshot } from "./storage/p2pkhChainStore.js";
export * from "./storage/p2pkhFileFormats.js";
export { createP2pkhCoordinatorTasks } from "./p2pkhCoordinatorTasks.js";
export { createP2pkhProtocolSpendService } from "./p2pkhProtocolSpend.js";
