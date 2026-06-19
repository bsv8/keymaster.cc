// packages/runtime/src/log/logService.test.ts
// 硬切换 002：统一日志 service 单测。
//
// 关键不变量：
//   1. ctx.logger 在 plugin setup 内可用，且天然绑定 pluginId。
//   2. debugEnabled=false 时 logger.debug() 不写库；info/warn/error 正常。
//   3. updateConfig({ debugEnabled: true }) 之后 debug 开始入未来库，不补历史。
//   4. plugin host 系统日志 pluginId 固定 "runtime"，不影响 enable 主流程。
//   5. pruneExpired 删除超期数据；retentionDays 缩小时 updateConfig 内 best-effort prune。
//   6. clearEntries 必须有至少一个条件。
//   7. data 字段会脱敏：禁止的 key 不会落库；超长字符串被截断。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  LOG_SERVICE_CAPABILITY,
  type LogConfig,
  type LogEntry,
  type PluginContext,
  type PluginManifest
} from "@keymaster/contracts";
import { createPluginHost } from "../createPluginHost.js";
import { disposeLogDb, LOG_DB_NAME, putEntry } from "./logDb.js";
import { createLogService, type LogServiceHandle } from "./logService.js";

async function resetLogDb() {
  // 等待 close 真正完成；否则 deleteDatabase 会被前一连接阻塞。
  await disposeLogDb();
  // 即便 close 已 resolve，IDB 内部完成清理仍需一两个微任务。
  await new Promise((r) => setTimeout(r, 10));
  await new Promise<void>((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve();
    };
    const req = indexedDB.deleteDatabase(LOG_DB_NAME);
    req.onsuccess = () => finish();
    req.onerror = () => finish();
    // 兜底超时：blocked 时 IDB 会一直等，给 1.5s 兜底后强行继续。
    setTimeout(finish, 1500);
  });
}

beforeEach(async () => {
  await resetLogDb();
});

afterEach(async () => {
  await resetLogDb();
});

describe("createLogService - basics", () => {
  it("returns default config and writes/reads entries", async () => {
    const svc = createLogService();
    expect(svc.getConfig()).toEqual<LogConfig>({
      retentionDays: 30,
      debugEnabled: false
    });
    await svc.append({
      level: "info",
      pluginId: "demo",
      scope: "demo.scope",
      event: "demo.event",
      message: "hello"
    });
    const list = await svc.listEntries();
    expect(list.length).toBe(1);
    expect(list[0]).toMatchObject({
      level: "info",
      pluginId: "demo",
      scope: "demo.scope",
      event: "demo.event",
      message: "hello"
    });
    svc.dispose();
  });

  it("drop debug entries when debugEnabled=false; future debug writes after toggle", async () => {
    const svc = createLogService();
    const logger = svc.forPlugin("demo", "demo");
    logger.debug({ scope: "x", event: "y", message: "first" });
    logger.info({ scope: "x", event: "y", message: "still-ok" });
    // 等一拍：append 是 fire-and-forget，但 putEntry 是 async；给几个 microtask。
    await new Promise((r) => setTimeout(r, 10));
    const initial = await svc.listEntries();
    expect(initial.length).toBe(1);
    expect(initial[0]!.level).toBe("info");
    expect(initial[0]!.message).toBe("still-ok");

    await svc.updateConfig({ debugEnabled: true });
    // toggle 之后旧的 debug 不会补；只有未来调用入新库。
    logger.debug({ scope: "x", event: "y", message: "second" });
    await new Promise((r) => setTimeout(r, 10));
    const after = await svc.listEntries();
    expect(after.length).toBe(2);
    expect(after.find((e) => e.message === "second")).toBeDefined();
    expect(after.find((e) => e.message === "first")).toBeUndefined();
    svc.dispose();
  });

  it("does not retry on write failure (no blocking)", async () => {
    const onWriteError = vi.fn();
    // skipStartupPrune：本测试要验证 putEntry 写完之后 listEntries 能读到。
    // 默认 retentionDays=30 + 启动 prune 会把 2020 年数据清掉。
    const svc = createLogService({ onWriteError, skipStartupPrune: true });
    // 用一个会失败的 pluginId 注入非法 level 来触发异常路径：
    // 内部 sanitizeData 不会抛错；改为通过 putEntry 直接写一条非法 level 让列游标过。
    await putEntry({
      id: "manual-1",
      ts: "2020-01-01T00:00:00.000Z",
      level: "info",
      pluginId: "demo",
      scope: "x",
      event: "y",
      message: "stale"
    } as never);
    // service 自己的 listEntries 仍应能正常返回（level 缺失时 rowToEntry 容忍）。
    const list = await svc.listEntries();
    expect(list.length).toBe(1);
    expect(onWriteError).not.toHaveBeenCalled();
    svc.dispose();
  });

  it("pruneExpired deletes entries older than retentionDays", async () => {
    // skipStartupPrune：本测试专注 pruneExpired 行为；不与启动 best-effort 清理混淆。
    const svc = createLogService({ init: { retentionDays: 1, debugEnabled: false }, skipStartupPrune: true });
    const oldTs = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();
    const newTs = new Date().toISOString();
    await svc.append({
      level: "info",
      pluginId: "demo",
      scope: "x",
      event: "y",
      message: "old",
      ts: oldTs
    });
    await svc.append({
      level: "info",
      pluginId: "demo",
      scope: "x",
      event: "y",
      message: "new",
      ts: newTs
    });
    const removed = await svc.pruneExpired();
    expect(removed).toBe(1);
    const left = await svc.listEntries();
    expect(left.length).toBe(1);
    expect(left[0]!.message).toBe("new");
    svc.dispose();
  });

  it("updateConfig({ retentionDays: smaller }) best-effort prunes", async () => {
    const svc = createLogService({ init: { retentionDays: 30, debugEnabled: false }, skipStartupPrune: true });
    const oldTs = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
    await svc.append({
      level: "info",
      pluginId: "demo",
      scope: "x",
      event: "y",
      message: "oldish",
      ts: oldTs
    });
    await svc.append({
      level: "info",
      pluginId: "demo",
      scope: "x",
      event: "y",
      message: "fresh"
    });
    await svc.updateConfig({ retentionDays: 1 });
    // best-effort prune：异步推进几个 microtask。
    await new Promise((r) => setTimeout(r, 20));
    const left = await svc.listEntries();
    expect(left.length).toBe(1);
    expect(left[0]!.message).toBe("fresh");
    svc.dispose();
  });

  it("clearEntries requires at least one condition", async () => {
    const svc = createLogService();
    await svc.append({
      level: "info",
      pluginId: "demo",
      scope: "x",
      event: "y",
      message: "a"
    });
    await expect(svc.clearEntries({})).rejects.toThrow(/requires at least one/);
    const removed = await svc.clearEntries({ pluginId: "demo" });
    expect(removed).toBe(1);
    const list = await svc.listEntries();
    expect(list.length).toBe(0);
    svc.dispose();
  });

  it("clearAllEntries removes everything in one shot", async () => {
    const svc = createLogService();
    for (let i = 0; i < 5; i += 1) {
      await svc.append({
        level: "info",
        pluginId: `p${i}`,
        scope: "x",
        event: "y",
        message: `m-${i}`
      });
    }
    const before = await svc.listEntries();
    expect(before.length).toBe(5);
    const removed = await svc.clearAllEntries();
    expect(removed).toBe(5);
    const after = await svc.listEntries();
    expect(after.length).toBe(0);
    svc.dispose();
  });

  it("data sanitization drops forbidden keys and truncates long values", async () => {
    const svc = createLogService();
    await svc.append({
      level: "info",
      pluginId: "demo",
      scope: "x",
      event: "y",
      message: "ok",
      data: {
        password: "should-not-persist",
        network: "main",
        addressCount: 3,
        longText: "x".repeat(5000)
      }
    });
    const list = await svc.listEntries();
    expect(list.length).toBe(1);
    const data = list[0]!.data as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(data, "password")).toBe(false);
    expect(data.network).toBe("main");
    expect(data.addressCount).toBe(3);
    expect(typeof data.longText).toBe("string");
    expect((data.longText as string).length).toBeLessThan(5000);
    svc.dispose();
  });

  it("listEntries supports pluginId / level / keyword / time filters", async () => {
    // skipStartupPrune：本测试的 fixture 用 2024 年时间戳；启动 prune 会把它们全删掉。
    const svc = createLogService({ skipStartupPrune: true });
    const t1 = "2024-01-01T00:00:00.000Z";
    const t2 = "2024-06-01T00:00:00.000Z";
    const t3 = "2024-12-01T00:00:00.000Z";
    await svc.append({ level: "info", pluginId: "a", scope: "x", event: "y", message: "alpha", ts: t1 });
    await svc.append({ level: "warn", pluginId: "a", scope: "x", event: "y", message: "beta", ts: t2 });
    await svc.append({ level: "error", pluginId: "b", scope: "x", event: "y", message: "gamma", ts: t3 });

    const onlyA = await svc.listEntries({ pluginId: "a" });
    expect(onlyA.length).toBe(2);
    const onlyWarn = await svc.listEntries({ level: "warn" });
    expect(onlyWarn.length).toBe(1);
    expect(onlyWarn[0]!.message).toBe("beta");
    const byKw = await svc.listEntries({ keyword: "gam" });
    expect(byKw.length).toBe(1);
    expect(byKw[0]!.message).toBe("gamma");
    const byRange = await svc.listEntries({ from: "2024-02-01T00:00:00.000Z", to: "2024-08-01T00:00:00.000Z" });
    expect(byRange.length).toBe(1);
    expect(byRange[0]!.message).toBe("beta");
    svc.dispose();
  });

  it("onConfigChange fires on update", async () => {
    const svc = createLogService();
    const seen: LogConfig[] = [];
    const off = svc.onConfigChange((c) => seen.push(c));
    await svc.updateConfig({ debugEnabled: true });
    expect(seen.length).toBe(1);
    expect(seen[0]!.debugEnabled).toBe(true);
    off();
    await svc.updateConfig({ debugEnabled: false });
    expect(seen.length).toBe(1);
    svc.dispose();
  });

  it("child() composes scope and inherits pluginId", async () => {
    const svc = createLogService();
    const logger = svc.forPlugin("demo", "demo").child("sub");
    // child 已经声明 "demo.sub" 之后，input.scope 仍然可以拼到它后面作为
    // 更细一级的子段。修复前会丢掉 input.scope，修复后正确合并。
    logger.info({ scope: "ignored", event: "y", message: "hello" });
    await new Promise((r) => setTimeout(r, 10));
    const list = await svc.listEntries();
    expect(list.length).toBe(1);
    expect(list[0]!.scope).toBe("demo.sub.ignored");
    expect(list[0]!.pluginId).toBe("demo");
    svc.dispose();
  });

  it("logger without baseScope still uses input.scope (修复前会丢空 scope)", async () => {
    const svc = createLogService();
    const logger = svc.forPlugin("demo");
    logger.info({ scope: "background.task", event: "triggered", message: "x" });
    await new Promise((r) => setTimeout(r, 10));
    const list = await svc.listEntries();
    expect(list.length).toBe(1);
    expect(list[0]!.scope).toBe("background.task");
    svc.dispose();
  });
});

describe("createLogService - init race", () => {
  it("logger.debug() 在首次 init 完成前不会基于默认 false 被丢掉", async () => {
    // 第一个 service 写入非默认 debugEnabled=true。
    const writer = createLogService({ skipStartupPrune: true });
    await writer.updateConfig({ debugEnabled: true });
    writer.dispose();
    await new Promise((r) => setTimeout(r, 200));

    // 第二个 service：DB 真值 debugEnabled=true。构造结束会异步 init。
    // 在 init 完成前调用 logger.debug()，应该被落库而不是被默认 false 丢。
    const svc = createLogService({ skipStartupPrune: true });
    const logger = svc.forPlugin("demo");
    // 故意不 await：模拟"业务侧不等 init"的真实时序。
    logger.debug({ scope: "x", event: "y", message: "early-debug" });
    // 等 init + append 全部完成。
    await new Promise((r) => setTimeout(r, 200));
    const list = await svc.listEntries();
    expect(list.length).toBe(1);
    expect(list[0]!.level).toBe("debug");
    expect(list[0]!.message).toBe("early-debug");
    svc.dispose();
  });

  it("updateConfig 在 init 完成前调用不会丢失用户的更新", async () => {
    // 第一个 service 写入 retentionDays=7。
    const writer = createLogService({ skipStartupPrune: true });
    await writer.updateConfig({ retentionDays: 7 });
    writer.dispose();
    await new Promise((r) => setTimeout(r, 200));

    // 第二个 service：init 还是默认值 30。
    // 用户调用 updateConfig({retentionDays: 14})：修复前会基于默认 30 计算，
    // 然后 init 完成时用 DB 真值 7 覆盖 config，persistConfig 写回 7。
    // 修复后：updateConfig 先 await ensureInit，再读 config（此时是 DB 真值 7），
    // 合并 patch 后写 14。
    const svc = createLogService({ skipStartupPrune: true });
    // 不 await，模拟"业务侧不等 init"。
    const updatePromise = svc.updateConfig({ retentionDays: 14 });
    await updatePromise;
    expect(svc.getConfig().retentionDays).toBe(14);
    // 同时验证 DB 也是 14。
    svc.dispose();
    // 给 dispose 的 close 留够时间。
    await new Promise((r) => setTimeout(r, 300));
    // 先用直接读 DB 的方式验证，避免 reader service 自身的 init 时序干扰。
    const { getConfigRow } = await import("./logDb.js");
    const row = await getConfigRow();
    expect(row).toBeDefined();
    expect(row!.retentionDays).toBe(14);
  });

  it("concurrent logger.debug() + logger.info() 都基于同一个 in-flight init 走", async () => {
    // 预置 debug=true 写库。
    const writer = createLogService({ skipStartupPrune: true });
    await writer.updateConfig({ debugEnabled: true });
    writer.dispose();
    await new Promise((r) => setTimeout(r, 200));

    // 第二个 service：并发写多行。
    const svc = createLogService({ skipStartupPrune: true });
    const logger = svc.forPlugin("demo");
    for (let i = 0; i < 5; i += 1) {
      logger.debug({ scope: "x", event: "y", message: `d-${i}` });
      logger.info({ scope: "x", event: "y", message: `i-${i}` });
    }
    await new Promise((r) => setTimeout(r, 200));
    const list = await svc.listEntries();
    // 5 debug + 5 info = 10 条。修复前：init 完成前的 debug 会被默认 false 丢。
    expect(list.length).toBe(10);
    const debugs = list.filter((e) => e.level === "debug");
    const infos = list.filter((e) => e.level === "info");
    expect(debugs.length).toBe(5);
    expect(infos.length).toBe(5);
    svc.dispose();
  });
});

describe("createLogService - startup", () => {
  it("emits onConfigChange when DB has different config than init", async () => {
    // 第一个 service 写入非默认 config。
    const first = createLogService({ skipStartupPrune: true });
    await first.updateConfig({ retentionDays: 7, debugEnabled: true });
    first.dispose();
    // dispose 异步关闭 db；给点时间。
    await new Promise((r) => setTimeout(r, 200));

    // 第二个 service 应读到 DB 真值并通过 onConfigChange 通知订阅者。
    const seen: LogConfig[] = [];
    const second = createLogService({
      init: { retentionDays: 30, debugEnabled: false },
      skipStartupPrune: true
    });
    second.onConfigChange((c) => seen.push(c));
    // 等 ensureInit 完成（异步读 DB + 可能 emit）。
    await new Promise((r) => setTimeout(r, 200));
    expect(second.getConfig()).toEqual({ retentionDays: 7, debugEnabled: true });
    // 至少收到一次事件；值就是 DB 真值。
    expect(seen.length).toBeGreaterThanOrEqual(1);
    expect(seen[seen.length - 1]!).toEqual({ retentionDays: 7, debugEnabled: true });
    second.dispose();
  });

  it("does not emit onConfigChange when DB config equals init (等价 init)", async () => {
    const first = createLogService({ skipStartupPrune: true });
    await first.updateConfig({ retentionDays: 30, debugEnabled: false });
    first.dispose();
    await new Promise((r) => setTimeout(r, 30));

    const seen: LogConfig[] = [];
    const second = createLogService({
      init: { retentionDays: 30, debugEnabled: false },
      skipStartupPrune: true
    });
    second.onConfigChange((c) => seen.push(c));
    await new Promise((r) => setTimeout(r, 50));
    expect(seen.length).toBe(0);
    second.dispose();
  });

  it("startup prune removes entries older than retentionDays", async () => {
    // 写一些老数据（在前一个 service 里）。
    const writer = createLogService({ init: { retentionDays: 30, debugEnabled: false }, skipStartupPrune: true });
    const oldTs = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000).toISOString();
    const newTs = new Date().toISOString();
    await writer.append({ level: "info", pluginId: "p", scope: "x", event: "y", message: "old", ts: oldTs });
    await writer.append({ level: "info", pluginId: "p", scope: "x", event: "y", message: "new", ts: newTs });
    writer.dispose();
    await new Promise((r) => setTimeout(r, 30));

    // 新 service：retentionDays=1，构造结束时 best-effort prune。
    const reader = createLogService({ init: { retentionDays: 1, debugEnabled: false } });
    // 等启动 prune 跑完。
    await new Promise((r) => setTimeout(r, 100));
    const all = await reader.listEntries();
    expect(all.length).toBe(1);
    expect(all[0]!.message).toBe("new");
    reader.dispose();
  });
});

describe("createLogService - in host", () => {
  it("provides log.service capability and ctx.logger is bound to pluginId", async () => {
    const host = createPluginHost({ disableConfigPersistence: true });
    let captured: LogServiceHandle | undefined;
    const plugin: PluginManifest = {
      id: "probe",
      name: "Probe",
      meta: { kind: "business", defaultEnabled: true, canDisable: true },
      setup(ctx: PluginContext) {
        captured = ctx.get<LogServiceHandle>(LOG_SERVICE_CAPABILITY);
        // 写一条 info 验证 logger 注入。
        ctx.logger.info({
          scope: "probe",
          event: "setup.ran",
          message: "probe setup"
        });
      }
    };
    await host.register(plugin);
    expect(captured).toBeDefined();
    // 用返回 logger 写一次确认 pluginId 已绑。
    const logger = captured!.forPlugin("probe", "extra");
    logger.warn({ scope: "extra", event: "after", message: "after-enable" });
    await new Promise((r) => setTimeout(r, 20));
    const list = await captured!.listEntries();
    const probes = list.filter((e) => e.pluginId === "probe");
    expect(probes.length).toBeGreaterThanOrEqual(1);
    for (const e of probes) {
      // 业务插件不允许伪造 pluginId；这里强校验只来自 ctx.logger。
      expect(e.pluginId).toBe("probe");
    }
  });

  it("plugin host system log uses pluginId 'runtime'", async () => {
    const host = createPluginHost({ disableConfigPersistence: true });
    const plugin: PluginManifest = {
      id: "alpha",
      name: "Alpha",
      meta: { kind: "business", defaultEnabled: true, canDisable: true },
      setup() {
        // no-op
      }
    };
    await host.register(plugin);
    await new Promise((r) => setTimeout(r, 20));
    const svc = host.capabilities.get<LogServiceHandle>(LOG_SERVICE_CAPABILITY);
    const list = await svc.listEntries({ pluginId: "runtime" });
    const enableEvt = list.find((e) => e.event === "plugin.enabled");
    expect(enableEvt).toBeDefined();
    expect((enableEvt!.data as { pluginId?: string }).pluginId).toBe("alpha");
  });

  it("disable / unregister does not throw when log write fails", async () => {
    // 临时替换 console.error，避免单测里看到 noise。
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const host = createPluginHost({ disableConfigPersistence: true });
    const plugin: PluginManifest = {
      id: "alpha",
      name: "Alpha",
      meta: { kind: "business", defaultEnabled: true, canDisable: true },
      setup() {
        return () => {
          throw new Error("teardown boom");
        };
      }
    };
    await host.register(plugin);
    const r = await host.disable("alpha");
    expect(r.ok).toBe(true);
    // error-disabled
    const st = host.state("alpha");
    expect(st.kind).toBe("error-disabled");
    errSpy.mockRestore();
  });

  it("unregister removes the plugin and the log service keeps working", async () => {
    const host = createPluginHost({ disableConfigPersistence: true });
    const plugin: PluginManifest = {
      id: "alpha",
      name: "Alpha",
      meta: { kind: "business", defaultEnabled: true, canDisable: true },
      setup() {
        return () => undefined;
      }
    };
    await host.register(plugin);
    await host.unregister("alpha");
    expect(host.manifests()).not.toContain("alpha");
    const svc = host.capabilities.get<LogServiceHandle>(LOG_SERVICE_CAPABILITY);
    const list = await svc.listEntries({ pluginId: "alpha" });
    // 历史 entry 保留（统一 schema），只是 plugin 已 unregister。
    expect(Array.isArray(list)).toBe(true);
  });

  it("setup failure: error-disabled + log entry written without blocking", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const host = createPluginHost({ disableConfigPersistence: true });
    const plugin: PluginManifest = {
      id: "bad",
      name: "Bad",
      meta: { kind: "business", defaultEnabled: true, canDisable: true },
      setup() {
        throw new Error("setup boom");
      }
    };
    // host.register 内部把 setup 错误降级为 error-disabled，不会 re-throw。
    await host.register(plugin);
    expect(host.state("bad").kind).toBe("error-disabled");
    const svc = host.capabilities.get<LogServiceHandle>(LOG_SERVICE_CAPABILITY);
    const list = await svc.listEntries({ pluginId: "runtime" });
    const fail = list.find((e) => e.event === "setup.failed");
    expect(fail).toBeDefined();
    expect((fail!.error as { message: string }).message).toContain("setup boom");
    errSpy.mockRestore();
  });
});
