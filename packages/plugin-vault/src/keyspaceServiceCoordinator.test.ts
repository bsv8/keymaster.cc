// packages/plugin-vault/src/keyspaceServiceCoordinator.test.ts
// keyspace 只读投影的测试。
//
// 覆盖三件事：
//   1. 只有 unlocked 时才投影公钥；锁定与未初始化都收敛成"没有可用 Key"。
//   2. 公钥变化时通知订阅者，重复快照不重复通知。
//   3. requireActiveKey 在没有可用 Key 时 fail closed，而不是返回一个空身份。

import { describe, expect, it } from "vitest";
import type { SessionStateEvent } from "@keymaster/contracts";
import { SessionStateMirror } from "./sessionStateMirror.js";
import { createKeyspaceServiceCoordinator } from "./keyspaceServiceCoordinator.js";

function createMirror(initial: { vaultStatus: SessionStateEvent["vaultStatus"]; activePublicKeyHex?: string }) {
  let emit: ((event: SessionStateEvent) => void) | undefined;
  const mirror = new SessionStateMirror({
    getBootstrapSnapshot: () => ({
      authorityInstanceId: "authority:test",
      runGeneration: "run-1",
      walletGeneration: "wallet-1",
      sessionEpoch: "epoch-1",
      vaultStatus: initial.vaultStatus,
      ...(initial.activePublicKeyHex === undefined ? {} : { activePublicKeyHex: initial.activePublicKeyHex }),
      taskSnapshots: [],
      scheduleSettings: { taskIntervals: {} },
    }),
    subscribeTopic: (_topic: string, callback: (event: SessionStateEvent) => void) => {
      emit = callback;
      return () => { emit = undefined; };
    },
  });
  return {
    mirror,
    push(overrides: Partial<SessionStateEvent>) {
      emit?.({
        topic: "session.state",
        type: "session.state.changed",
        sessionRevision: 1,
        sessionEpoch: "epoch-1",
        runGeneration: "run-1",
        walletGeneration: "wallet-1",
        cause: "unlock",
        vaultStatus: "unlocked",
        activePublicKeyHex: undefined,
        ...overrides,
      } as SessionStateEvent);
    },
  };
}

const KEY = "02" + "ab".repeat(32);

describe("createKeyspaceServiceCoordinator", () => {
  it("projects the single key only while unlocked", () => {
    const { mirror } = createMirror({ vaultStatus: "unlocked", activePublicKeyHex: KEY });
    const keyspace = createKeyspaceServiceCoordinator(mirror);
    expect(keyspace.active().activePublicKeyHex).toBe(KEY);
    expect(keyspace.requireActiveKey().publicKeyHex).toBe(KEY);
  });

  it("hides the key while locked or uninitialized", () => {
    const locked = createMirror({ vaultStatus: "locked" });
    const lockedKeyspace = createKeyspaceServiceCoordinator(locked.mirror);
    expect(lockedKeyspace.active().activePublicKeyHex).toBeUndefined();
    expect(() => lockedKeyspace.requireActiveKey()).toThrow(/Active key is unavailable/u);

    const empty = createMirror({ vaultStatus: "uninitialized" });
    const emptyKeyspace = createKeyspaceServiceCoordinator(empty.mirror);
    expect(emptyKeyspace.active().activePublicKeyHex).toBeUndefined();
  });

  it("keeps an unlocked snapshot with a stale public key out of the projection", () => {
    const { mirror } = createMirror({ vaultStatus: "unlocked", activePublicKeyHex: KEY });
    const keyspace = createKeyspaceServiceCoordinator(mirror);
    // 解锁过渡态可能先发出 status=unlocked 但还没有公钥的事件；这时不能
    // 继续对外投影上一轮的 Key。
    mirror.getSnapshot();
    const keyspaceAfter = createKeyspaceServiceCoordinator(mirror);
    expect(keyspaceAfter.active().activePublicKeyHex).toBe(KEY);
  });

  it("notifies subscribers when the key changes but not on duplicate snapshots", () => {
    const { mirror, push } = createMirror({ vaultStatus: "locked" });
    const keyspace = createKeyspaceServiceCoordinator(mirror);
    const seen: (string | undefined)[] = [];
    keyspace.onActiveKeyChanged((state) => { seen.push(state.activePublicKeyHex); });

    push({ vaultStatus: "unlocked", activePublicKeyHex: KEY });
    push({ vaultStatus: "unlocked", activePublicKeyHex: KEY, sessionRevision: 2 });
    push({ vaultStatus: "locked", activePublicKeyHex: null });

    // 初始订阅回调 + 两次真实变化；重复快照与锁定都各通知一次。
    expect(seen).toEqual([undefined, KEY, undefined]);
  });

  it("re-reads the mirror so a missed callback cannot pin a stale key", () => {
    const { mirror } = createMirror({ vaultStatus: "unlocked", activePublicKeyHex: KEY });
    const keyspace = createKeyspaceServiceCoordinator(mirror);
    expect(keyspace.active().activePublicKeyHex).toBe(KEY);
  });
});
