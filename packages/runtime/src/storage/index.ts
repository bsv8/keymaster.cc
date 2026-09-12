// Worker-safe runtime utilities.
//
// This entrypoint is intentionally kept separate from `../index.ts`. The
// latter is the Window/UI runtime barrel and re-exports React components and
// hooks. Code reachable from a SharedWorker must import this entrypoint (or a
// narrower contracts module) so a development bundler cannot pull the Window
// module graph into the Worker.

export { createInMemoryKeyValueStore } from "./inMemoryKeyValueStore.js";
export { createKeyValueSettingsStore, type KeyValueSettingsStore } from "../keyValueSettingsStore.js";
