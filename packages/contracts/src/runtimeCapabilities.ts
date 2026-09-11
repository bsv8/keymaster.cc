// Keymaster 运行时能力标识。
//
import { defineCapability } from "webloom-framework";
import type { MessageBus } from "webloom-framework";

/** Keymaster 共享事件总线 capability。 */
export const RUNTIME_MESSAGE_BUS = defineCapability<MessageBus>({
  kind: "local",
  id: "runtime.messageBus",
  version: "1",
});
