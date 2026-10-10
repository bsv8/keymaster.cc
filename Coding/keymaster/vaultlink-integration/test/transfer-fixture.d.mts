import type { CoordinatorWalletPaymentCommand, JSONValue } from '@keymaster/contracts';
export function paymentRequester(privateKeyHex: string): (command: CoordinatorWalletPaymentCommand) => Promise<JSONValue>;
export function fundingCoin(publicKeyHex: string, value: number, seed?: string, vout?: number): {txid: string; vout: number; value: number};
export function previousTransactions(network: string, inputs: readonly {txid: string}[]): Promise<string[]>;
export function cleanupPayments(): Promise<void>;

export function rememberTransaction(rawHex: string): string;
