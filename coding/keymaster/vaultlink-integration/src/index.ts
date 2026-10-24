export { validateHardwareKeyDocument, type HardwareKeyDocumentV1 } from "./hardware-key-record.js";
export { HardwareConnectionOwner, type HardwareConnectionState } from "./hardware-connection.js";

export * from "./hardware-backend.js";
export * from "./payment.js";
export * from "./wallet-payments.js";
export * from "./bitfs-payments.js";
export * from "./protocol-payments.js";
export * from "./usb-bridge.js";

export { HardwareWalletPayments } from "./hardware-payments.js";
export { authenticateAppWallet } from "./app-wallet-auth.js";
export { appPaymentChannelId, publisherPaymentOwner, publisherPaymentChannelId, publisherPaymentSessionId } from "./app-payment-channel.js";
export { createHardwareChannelAdapter } from "./channel-adapter.js";

export * from "./signature-history.js";
