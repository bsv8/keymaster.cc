// packages/plugin-p2pkh/src/index.ts
export { p2pkhPlugin } from "./manifest.js";
export { P2PKH_CAPABILITY } from "./p2pkhContracts.js";
export { openP2pkhDb, createP2pkhDb } from "./p2pkhDb.js";
export { createP2pkhCoordinatorTasks } from "./p2pkhCoordinatorTasks.js";
export { createP2pkhProtocolSpendService } from "./p2pkhProtocolSpend.js";
