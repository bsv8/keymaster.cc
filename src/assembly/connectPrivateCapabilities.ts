import { definePrivateCapability } from "webloom-framework/advanced";
import { CONNECT_PRIVATE_COMMAND, CONNECT_PRIVATE_EVENTS } from "@keymaster/plugin-connect/assembly";
declare const __KEYMASTER_CONNECT_PRIVATE_GRANT__: string;
export const connectPrivateCapabilities = () => typeof __KEYMASTER_CONNECT_PRIVATE_GRANT__ === "undefined" ? [] : [CONNECT_PRIVATE_COMMAND, CONNECT_PRIVATE_EVENTS].map(capability => definePrivateCapability({ capability, pluginId: "protocol", unitId: "protocol.window", grantId: __KEYMASTER_CONNECT_PRIVATE_GRANT__ }));
export const connectPrivateSlotBindings = (slotId: string) => Object.fromEntries([CONNECT_PRIVATE_COMMAND, CONNECT_PRIVATE_EVENTS].map(c => [`protocol\0protocol.window\0${c.kind}\0${c.id}\0${c.version}`, slotId]));
