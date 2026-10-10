export function openTransactionEvidenceServer(transactions: Map<string, string>): Promise<{ endpoint: string; close(): Promise<void> }>;
