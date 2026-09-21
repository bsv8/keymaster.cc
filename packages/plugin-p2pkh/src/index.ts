// packages/plugin-p2pkh/src/index.ts
export { p2pkhPlugin, p2pkhSetup } from "./manifest.js";
export { P2PKH_CAPABILITY } from "./p2pkhContracts.js";
export { p2pkhAddressCodec } from "./p2pkhAddressCodec.js";
export { openP2pkhStateRepository, createP2pkhStateRepository } from "./storage/p2pkhStateRepository.js";
export { createP2pkhFileRepository } from "./storage/p2pkhFileRepository.js";
export type { P2pkhFileRepositoryHandle } from "./storage/p2pkhFileRepository.js";
export * from "./storage/p2pkhFileFormats.js";
export { createP2pkhCoordinatorTasks } from "./p2pkhCoordinatorTasks.js";
export { createP2pkhProtocolSpendService } from "./p2pkhProtocolSpend.js";
