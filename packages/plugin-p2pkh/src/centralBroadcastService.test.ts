import { describe, expect, it, vi } from "vitest";
import type { P2pkhUtxoSnapshotResult } from "@keymaster/contracts";
import { CentralBroadcastRetryableError, createCentralBroadcastService, type CentralBroadcastServiceDeps } from "./centralBroadcastService.js";

const txid = "aa".repeat(32);
const baseInput = {
  ownerPublicKeyHex: "02" + "11".repeat(32),
  network: "main" as const,
  resourceId: "p2pkh:main",
  txid,
  rawTxHex: "00",
  utxoBinding: { resourceId: "p2pkh:main", seq: 1 },
};

function snapshot(seq: number, state: "fresh" | "consumed" = "fresh"): P2pkhUtxoSnapshotResult {
  return { available: state === "fresh", seq, state, items: [] };
}

function deps(overrides: Partial<CentralBroadcastServiceDeps> = {}): CentralBroadcastServiceDeps {
  return {
    coordinator: { p2pkhBroadcast: vi.fn(async () => ({ status: "ok" as const, sessionEpoch: "test", value: { status: "local-confirmed", txid } })) },
    sleep: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe("central broadcast service", () => {
  it("retries only after a newer snapshot sequence", async () => {
    const attemptResults = [
      { submissionId: "s1", result: { status: "not-dispatched" as const, reason: "snapshot-consumed" as const, currentSeq: 1 } },
      { submissionId: "s2", result: { status: "local-confirmed" as const, txid } },
    ];
    const attempt = vi.fn(async () => attemptResults.shift()!);
    const refreshSnapshot = vi.fn(async () => snapshot(2));
    const service = createCentralBroadcastService(deps({ refreshSnapshot, maxAttempts: 3, initialBackoffMs: 1 }));
    const result = await service.submitWithRetry({ network: "main", boundSeq: 1, attempt });
    expect(result).toMatchObject({ status: "local-confirmed", attempts: 2, txid });
    expect(refreshSnapshot).toHaveBeenCalledWith("main");
  });

  it("stops immediately on isolated results", async () => {
    const attempt = vi.fn(async () => ({ submissionId: "s1", result: { status: "isolated" as const, txid, reason: "timeout" } }));
    const service = createCentralBroadcastService(deps({ maxAttempts: 5 }));
    await expect(service.submitWithRetry({ network: "main", attempt })).resolves.toMatchObject({ status: "isolated", attempts: 1, reason: "isolated" });
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it("honors the five-attempt budget and reports snapshot-timeout", async () => {
    const attempt = vi.fn(async () => ({ submissionId: "s", result: { status: "not-dispatched" as const, reason: "coordinator-not-dispatched" as const } }));
    const service = createCentralBroadcastService(deps({ maxAttempts: 5, initialBackoffMs: 0, maxBackoffMs: 0 }));
    const result = await service.submitWithRetry({ network: "main", attempt });
    expect(result).toMatchObject({
      status: "failed",
      attempts: 5,
      reason: "snapshot-timeout",
      error: "等待新快照超时，上一笔交易状态未确认，请稍后检查交易记录",
    });
  });

  it("retries after a consumed snapshot is reopened with the same seq", async () => {
    let refreshes = 0;
    const attemptResults = [
      { submissionId: "s1", result: { status: "not-dispatched" as const, reason: "snapshot-consumed" as const, currentSeq: 1 } },
      { submissionId: "s2", result: { status: "local-confirmed" as const, txid } },
    ];
    const service = createCentralBroadcastService(deps({
      initialBackoffMs: 1,
      maxAttempts: 2,
      refreshSnapshot: vi.fn(async () => {
        refreshes += 1;
        return snapshot(1, refreshes < 2 ? "consumed" : "fresh");
      }),
    }));
    const result = await service.submitWithRetry({
      network: "main",
      boundSeq: 1,
      attempt: vi.fn(async () => attemptResults.shift()!),
    });
    expect(result).toMatchObject({ status: "local-confirmed", attempts: 2, txid });
    expect(refreshes).toBeGreaterThanOrEqual(2);
  });

  it("does not retry when rebuild fails with a terminal business error", async () => {
    const attempt = vi.fn(async () => { throw new Error("insufficient balance"); });
    const service = createCentralBroadcastService(deps({ maxAttempts: 5 }));
    await expect(service.submitWithRetry({ network: "main", attempt })).resolves.toMatchObject({
      status: "failed",
      attempts: 1,
      reason: "insufficient",
    });
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it("does not consume an attempt when rebuilding waits for a fresh snapshot", async () => {
    const attempt = vi.fn()
      .mockRejectedValueOnce(new CentralBroadcastRetryableError("snapshot-wait", 1))
      .mockResolvedValueOnce({ submissionId: "s2", result: { status: "local-confirmed" as const, txid } });
    const service = createCentralBroadcastService(deps({
      refreshSnapshot: vi.fn(async () => snapshot(2)),
      maxAttempts: 1,
      initialBackoffMs: 0,
    }));
    const result = await service.submitWithRetry({ network: "main", boundSeq: 1, attempt });
    expect(result).toMatchObject({ status: "local-confirmed", attempts: 1, txid });
    expect(attempt).toHaveBeenCalledTimes(2);
  });

  it("cancels a retry wait immediately", async () => {
    const controller = new AbortController();
    const attempt = vi.fn(async () => {
      controller.abort();
      throw new CentralBroadcastRetryableError("snapshot-wait", 1);
    });
    const service = createCentralBroadcastService(deps({
      sleep: (_ms, signal) => new Promise<void>((_resolve, reject) => signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true })),
    }));
    await expect(service.submitWithRetry({ network: "main", boundSeq: 1, attempt, signal: controller.signal })).resolves.toMatchObject({ status: "failed", reason: "cancelled", attempts: 0 });
  });
});
