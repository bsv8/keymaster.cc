// P2P（WebRTC）桶内设置文件仓储：`p2p/setting.json`。
//
// 真值规则（KeymasterFormats《桶/<owner>/p2p/setting.json》）：
//   - 文件缺失或损坏 = 全部默认,不阻塞插件启动;
//   - 保存 = 整文件替换;写盘成功后才提交内存并通知订阅者。

import type { BorrowedOwnerFileStore } from "@keymaster/contracts";
import {
  DEFAULT_STUN_SERVERS,
  coerceWebrtcConfig,
  validateStunServers,
  type WebrtcConfig,
  type WebrtcConfigStore,
} from "../webrtcConfig.js";
import {
  P2P_SETTING_FILE_NAME,
  parseP2pSettingFile,
  serializeP2pSettingFile,
} from "./p2pSettingFileFormats.js";

/** Repository 只接收 Host 已绑定的 `p2p/` owner 文件根。 */
export function createP2pSettingFileRepository(files: BorrowedOwnerFileStore) {
  async function readConfig(): Promise<WebrtcConfig> {
    const object = await files.get(P2P_SETTING_FILE_NAME);
    if (!object) return { stunServers: [...DEFAULT_STUN_SERVERS] };
    return coerceWebrtcConfig(parseP2pSettingFile(object.bytes));
  }

  async function writeConfig(config: WebrtcConfig): Promise<void> {
    await files.put(P2P_SETTING_FILE_NAME, serializeP2pSettingFile(config));
  }

  return { readConfig, writeConfig };
}

export type P2pSettingFileRepositoryHandle = ReturnType<typeof createP2pSettingFileRepository>;

/**
 * 文件-backed 配置存储。**单例**——一个 plugin-webrtc enable 周期
 * 内只持有一份内存真值。
 *
 * 设计要点：
 *   - 构造时只建立内存默认值,首次读取由 `ready()` 完成；
 *   - `save` 串行写文件,写盘成功后才提交内存并通知订阅者；
 *   - 写失败抛错时内存态仍保留**上次成功**的真值,避免脏读。
 */
export function createFileWebrtcConfigStore(files: BorrowedOwnerFileStore): WebrtcConfigStore {
  const repository = createP2pSettingFileRepository(files);
  let current: WebrtcConfig = { stunServers: [...DEFAULT_STUN_SERVERS] };
  const subscribers = new Set<(c: WebrtcConfig) => void>();
  let writeQueue = Promise.resolve();

  async function ready(): Promise<void> {
    current = await repository.readConfig();
  }

  function snapshot(): WebrtcConfig {
    return { stunServers: [...current.stunServers] };
  }

  function notify(): void {
    for (const handler of subscribers) {
      try {
        handler(snapshot());
      } catch {
        // 防御性吞掉 handler 异常——配置订阅不影响持久结果。
      }
    }
  }

  function save(next: WebrtcConfig): Promise<void> {
    const validated = validateStunServers(next.stunServers);
    if (!validated.ok || validated.value === undefined) {
      throw new Error(validated.error ?? "invalid_config");
    }
    const normalized: WebrtcConfig = { stunServers: validated.value };
    const result = writeQueue.then(async () => {
      await repository.writeConfig(normalized);
      current = normalized;
      notify();
    });
    writeQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  return {
    load: () => ({ ...current, stunServers: [...current.stunServers] }),
    save,
    subscribe(handler) {
      subscribers.add(handler);
      return () => {
        subscribers.delete(handler);
      };
    },
    snapshot,
    ready
  };
}
