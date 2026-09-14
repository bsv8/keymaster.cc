/** 中央系统固定 CAS snapshot 契约。 */

import type { PluginStorageDeclaration } from "./access.js";
import type { KeyValueJson } from "./kv.js";

/** Snapshot 经 JSON envelope 持久化；二进制值仍只属于 K-V 契约。 */
export type StorageSnapshotJsonValue = KeyValueJson;

type ContainsNonJsonValue<T, Depth extends readonly unknown[] = []> =
  Depth["length"] extends 8 ? false
    : T extends Uint8Array | ArrayBuffer | Date | ((...args: never[]) => unknown) | bigint | symbol ? true
      : T extends null | boolean | number | string | undefined ? false
        : T extends readonly (infer Item)[] ? ContainsNonJsonValue<Item, [...Depth, 0]>
          : T extends object
            ? true extends { [Key in keyof T]-?: ContainsNonJsonValue<Exclude<T[Key], undefined>, [...Depth, 0]> }[keyof T] ? true : false
            : false;

/** 保留业务对象的精确类型，同时在编译期排除明确的非 JSON 字段。 */
export type StorageSnapshotJsonCompatible<T> = ContainsNonJsonValue<T> extends true ? never : T;

/** 固定对象内的严格 envelope；Provider ETag 不属于此契约。 */
export interface StorageSnapshotEnvelope<T = StorageSnapshotJsonValue> {
  format: "keymaster.storage.snapshot";
  version: 1;
  declaration: PluginStorageDeclaration;
  revision: number;
  value: T;
}

/** snapshot 读取结果；不存在的固定对象返回 undefined。 */
export interface StorageSnapshot<T> {
  value: T;
  revision: number;
}

/** snapshot 写入结果；same semantic value 时 wrote=false 且 revision 不变。 */
export interface StorageSnapshotWriteResult {
  revision: number;
  wrote: boolean;
}

/** 固定对象 CAS 条件；revision 0 表示对象不存在。 */
export interface StorageSnapshotWriteCondition {
  ifRevision?: number;
}

/**
 * Hold commit-head CAS 前置条件。
 *
 * `absent` 与省略条件不同：它明确要求提交头在本次发布前不存在，
 * 并在最终 Provider 写入时使用 if-none-match。
 */
export type StorageHoldHeadExpectation =
  | { kind: "etag"; etag: string }
  | { kind: "absent" };

/** 不暴露物理对象路径/ETag 的固定 CAS snapshot 句柄。 */
export interface SnapshotStore<T> {
  read(): Promise<StorageSnapshot<T> | undefined>;
  write(value: StorageSnapshotJsonCompatible<T>, condition?: StorageSnapshotWriteCondition): Promise<StorageSnapshotWriteResult>;
  close(): void;
}
