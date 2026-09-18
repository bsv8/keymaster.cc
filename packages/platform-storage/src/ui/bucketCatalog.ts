// packages/platform-storage/src/ui/bucketCatalog.ts
// 本机桶目录的页面侧读取（设备记录 + session）。
//
// 数据来源：
//   - 本机桶清单 = `keymaster.device.<ID>` 记录（一桶一条）；
//   - 当前桶 = `keymaster.session` 的 activeBucketId；
//   - s3 绑定需要 session 的公开 KDF 参数（所有 s3 桶共用一把启动密码派生）。
//
// 桶管理页、顶栏切换器与桶内 Key 列表都从这里读取，避免各自复制目录解析。

import type { DeviceRecordV1, StorageRuntimeBucketV1 } from "@keymaster/contracts";
import { createDeviceRecordRepository, defaultDeviceStorage, readSession } from "../index.js";

export interface BucketRow {
  bucketId: string;
  label: string;
  backend: "local" | "s3";
  record: DeviceRecordV1;
  current: boolean;
  /** s3 记录里已缓存的条件写能力；缺失表示尚未探测。 */
  conditionalWrites?: "native" | "best-effort";
}

/** 读取本机全部桶记录，当前桶排最前。 */
export function loadBuckets(): BucketRow[] {
  const storage = defaultDeviceStorage();
  const session = readSession(storage);
  const { entries } = createDeviceRecordRepository(storage).list();
  return entries
    .map((entry) => {
      const conditionalWrites = entry.record.location.providerId === "s3"
        ? (entry.record as Extract<DeviceRecordV1, { location: { providerId: "s3" } }>).capabilities?.conditionalWrites
        : undefined;
      return {
        bucketId: entry.remoteStorageId,
        label: entry.record.displayName ?? entry.remoteStorageId,
        backend: entry.record.location.providerId,
        record: entry.record,
        current: session?.activeBucketId === entry.remoteStorageId,
        ...(conditionalWrites === undefined ? {} : { conditionalWrites }),
      };
    })
    .sort((left, right) => Number(right.current) - Number(left.current) || left.label.localeCompare(right.label));
}

/** 由设备目录行构造可序列化的运行时绑定；s3 需要 session 的公开 KDF 参数。 */
export function toBinding(row: BucketRow): StorageRuntimeBucketV1 {
  const session = readSession(defaultDeviceStorage());
  return {
    bucketId: row.bucketId,
    backend: row.backend,
    label: row.label,
    deviceRecord: row.record,
    ...(row.backend === "s3" && session?.keyDerivation ? { keyDerivation: session.keyDerivation } : {}),
  };
}
