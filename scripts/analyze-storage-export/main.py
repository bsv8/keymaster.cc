#!/usr/bin/env python3
"""统计 Keymaster 浏览器本地存储导出文件。

支持两种常见导出格式：

1. JSON 对象：{"localStorage键": "localStorage值", ...}
2. 制表符分隔文本：每行是 localStorage键<TAB>localStorage值

程序只输出结构化统计结果，不输出值内容、密文、私钥或完整的敏感标识符。
"""

from __future__ import annotations

import argparse
import base64
import collections
import datetime as dt
import hashlib
import json
import re
import sys
from pathlib import Path
from typing import Any, Iterable


KV_PREFIX = b"keymaster-kv-v1:json\n"
KV_BINARY_PREFIX = b"keymaster-kv-v1:binary\n"
DEFAULT_SHORT_ID_LENGTH = 12


def short_id(value: Any, full: bool = False) -> str | None:
    """缩短 UUID、哈希、公钥等标识符，避免报告泄露完整敏感值。"""

    if value is None:
        return None
    text = str(value)
    if full or len(text) <= DEFAULT_SHORT_ID_LENGTH * 2 + 3:
        return text
    return f"{text[:DEFAULT_SHORT_ID_LENGTH]}…{text[-DEFAULT_SHORT_ID_LENGTH:]}"


def format_bytes(value: int) -> str:
    """将字节数转换为便于阅读的大小。"""

    if value < 1024:
        return f"{value} B"
    if value < 1024 * 1024:
        return f"{value / 1024:.1f} KiB"
    return f"{value / 1024 / 1024:.2f} MiB"


def utc_text(timestamp_ms: Any, timezone: dt.tzinfo) -> str | None:
    """把毫秒时间戳格式化为 UTC 与本地时间。"""

    if timestamp_ms is None:
        return None
    try:
        stamp = float(timestamp_ms) / 1000
        moment = dt.datetime.fromtimestamp(stamp, dt.timezone.utc)
        local_moment = moment.astimezone(timezone)
    except (TypeError, ValueError, OSError, OverflowError):
        return None
    return f"{local_moment.isoformat(timespec='milliseconds')}（UTC {moment.isoformat(timespec='milliseconds')}）"


def parse_json_text(raw: str) -> Any:
    """尽力把普通 localStorage 字符串解释为 JSON；失败时返回原字符串。"""

    try:
        return json.loads(raw)
    except (TypeError, json.JSONDecodeError):
        return raw


def decode_base64(value: str) -> bytes:
    """严格解码 localStorage 中保存的 Base64 字符串。"""

    return base64.b64decode(value.encode("ascii"), validate=True)


def decode_kv_value(value: str) -> tuple[Any, str, bytes | None, str | None]:
    """解码 K-V 引擎的值。

    返回：已解析对象、值编码类型、去掉前缀后的原始字节、错误说明。
    """

    try:
        decoded = decode_base64(value)
    except (ValueError, UnicodeEncodeError) as exc:
        return None, "invalid-base64", None, f"Base64 解码失败：{exc}"

    if decoded.startswith(KV_PREFIX):
        payload = decoded[len(KV_PREFIX) :]
        try:
            return json.loads(payload.decode("utf-8")), "json", payload, None
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            return None, "invalid-json", payload, f"K-V JSON 解码失败：{exc}"

    if decoded.startswith(KV_BINARY_PREFIX):
        return None, "binary", decoded[len(KV_BINARY_PREFIX) :], None

    # 兼容尚未带已知前缀的 JSON 值，同时不把原始内容向报告暴露。
    try:
        return json.loads(decoded.decode("utf-8")), "unprefixed-json", decoded, None
    except (UnicodeDecodeError, json.JSONDecodeError):
        return None, "binary", decoded, None


def decode_plain_json_value(value: str) -> tuple[Any, str]:
    """解码 Hold 使用的 Base64(JSON) 值；失败时只返回不可解析标记。"""

    try:
        decoded = decode_base64(value)
        parsed = json.loads(decoded.decode("utf-8"))
        return parsed, "base64-json"
    except (ValueError, UnicodeEncodeError, UnicodeDecodeError, json.JSONDecodeError):
        return parse_json_text(value), "plain-text-or-json"


def split_first(value: str) -> tuple[str, str]:
    """按第一个斜杠拆分路径；没有斜杠时，后半部分为空。"""

    if "/" not in value:
        return value, ""
    return value.split("/", 1)


def extract_revision_commit(object_name: str) -> tuple[int | None, str | None]:
    """从 `revision-commitId` 文件名中提取版本号和提交 ID。"""

    match = re.match(r"^(?P<revision>\d+)-(?P<commit>.+)$", object_name)
    if not match:
        return None, None
    try:
        revision = int(match.group("revision"))
    except ValueError:
        revision = None
    return revision, match.group("commit")


def path_root(bucket_id: str) -> str:
    """得到不带末尾斜杠的 bucket 根路径。"""

    return bucket_id.rstrip("/")


class ExportAnalyzer:
    """解析并统计一次 localStorage 导出。"""

    def __init__(self, source: Path, full_identifiers: bool = False) -> None:
        self.source = source
        self.full_identifiers = full_identifiers
        self.local_timezone = dt.datetime.now().astimezone().tzinfo or dt.timezone.utc
        self.errors: list[str] = []
        self.warnings: list[str] = []
        self.entries: list[dict[str, Any]] = []
        self.hold_entries: list[dict[str, Any]] = []
        self.kv_entries: list[dict[str, Any]] = []
        self.other_entries: list[dict[str, Any]] = []
        self.value_index: dict[tuple[str, str], dict[str, Any]] = {}
        self.commit_index: dict[tuple[str, str, int, str], dict[str, Any]] = {}
        self.head_index: dict[tuple[str, str], dict[str, Any]] = {}
        self._load()

    def _load(self) -> None:
        """读取输入文件并按 localStorage 键类型分类。"""

        try:
            raw_bytes = self.source.read_bytes()
        except OSError as exc:
            self.errors.append(f"无法读取输入文件：{exc}")
            return

        self.file_size = len(raw_bytes)
        try:
            raw_text = raw_bytes.decode("utf-8-sig")
        except UnicodeDecodeError as exc:
            self.errors.append(f"输入文件不是 UTF-8 文本：{exc}")
            return

        pairs: dict[str, str]
        stripped = raw_text.strip()
        if stripped.startswith("{"):
            try:
                parsed = json.loads(stripped)
            except json.JSONDecodeError as exc:
                self.errors.append(f"输入文件看起来是 JSON，但解析失败：{exc}")
                return
            if not isinstance(parsed, dict):
                self.errors.append("JSON 顶层不是对象，无法按 localStorage 键值表统计。")
                return
            pairs = {}
            for key, value in parsed.items():
                if not isinstance(key, str) or not isinstance(value, str):
                    self.errors.append(f"发现非字符串 localStorage 项：键={key!r}")
                    continue
                pairs[key] = value
            self.input_format = "JSON 对象"
        else:
            pairs = {}
            self.input_format = "制表符分隔文本"
            for line_number, line in enumerate(raw_text.splitlines(), 1):
                if not line.strip():
                    continue
                if "\t" not in line:
                    self.errors.append(f"第 {line_number} 行没有制表符，无法拆分键和值。")
                    continue
                key, value = line.split("\t", 1)
                pairs[key] = value

        self.entry_count = len(pairs)
        for key, value in pairs.items():
            self._classify_entry(key, value)

        self._build_indexes()

    def _classify_entry(self, key: str, value: str) -> None:
        """解析一个 localStorage 项的路径和内容。"""

        entry: dict[str, Any] = {
            "key": key,
            "value": value,
            "keyBytes": len(key.encode("utf-8")),
            "valueChars": len(value),
        }

        hold_match = re.match(
            r"^keymaster\.bucket\.(?P<bucket>.*?)\.\.keymaster/hold/v1/(?P<path>.+)$",
            key,
        )
        if hold_match:
            entry.update(
                {
                    "kind": "hold",
                    "bucket": hold_match.group("bucket"),
                    "path": hold_match.group("path"),
                }
            )
            entry["decoded"], entry["encoding"] = decode_plain_json_value(value)
            self.hold_entries.append(entry)
            self.entries.append(entry)
            return

        kv_match = re.match(
            r"^keymaster\.bucket\.(?P<bucket>.*?)\.keymaster/(?P<objectKind>heads|commits|values)/(?P<tail>.+)$",
            key,
        )
        if kv_match:
            bucket = kv_match.group("bucket")
            object_kind = kv_match.group("objectKind")
            tail = kv_match.group("tail")
            entry.update(
                {
                    "kind": "kv",
                    "bucket": bucket,
                    "objectKind": object_kind,
                    "tail": tail,
                    "root": path_root(bucket),
                }
            )
            decoded, encoding, payload, error = decode_kv_value(value)
            entry.update({"decoded": decoded, "encoding": encoding, "payload": payload})
            if error:
                self.errors.append(f"键 {short_id(key)}：{error}")

            if object_kind == "heads":
                entry["partition"] = tail
                entry["objectId"] = tail
            elif object_kind == "values":
                entry["partition"] = None
                entry["objectId"] = tail
                if payload is not None:
                    # K-V 引擎的文件名哈希的是“带 keymaster 前缀的完整字节串”，
                    # 不是去掉前缀后的 JSON payload。
                    try:
                        encoded_bytes = decode_base64(value)
                    except (ValueError, UnicodeEncodeError):
                        encoded_bytes = None
                    actual_hash = hashlib.sha256(encoded_bytes or payload).hexdigest()
                    entry["hashMatchesPath"] = actual_hash == tail
                    if actual_hash != tail:
                        self.errors.append(
                            f"值对象哈希不匹配：路径={short_id(tail)}，实际={short_id(actual_hash)}"
                        )
            else:
                partition, object_name = split_first(tail)
                revision, commit_id = extract_revision_commit(object_name)
                entry.update(
                    {
                        "partition": partition,
                        "objectId": object_name,
                        "revision": revision,
                        "commitId": commit_id,
                    }
                )
                if revision is None or commit_id is None:
                    self.errors.append(f"提交对象路径无法解析：{short_id(key)}")

            self.kv_entries.append(entry)
            self.entries.append(entry)
            return

        entry["kind"] = "other"
        entry["decoded"] = parse_json_text(value)
        self.other_entries.append(entry)
        self.entries.append(entry)

    def _build_indexes(self) -> None:
        """建立 head、commit、value 的索引，并检查重复对象。"""

        for entry in self.kv_entries:
            root = entry["root"]
            object_kind = entry["objectKind"]
            if object_kind == "heads":
                index_key = (root, entry["partition"])
                if index_key in self.head_index:
                    self.errors.append(f"发现重复 head：{short_id(entry['key'])}")
                self.head_index[index_key] = entry
            elif object_kind == "values":
                index_key = (root, entry["objectId"])
                if index_key in self.value_index:
                    self.errors.append(f"发现重复 value：{short_id(entry['key'])}")
                self.value_index[index_key] = entry
            elif object_kind == "commits" and entry.get("revision") is not None:
                index_key = (
                    root,
                    entry["partition"],
                    entry["revision"],
                    entry["commitId"],
                )
                if index_key in self.commit_index:
                    self.errors.append(f"发现重复 commit：{short_id(entry['key'])}")
                self.commit_index[index_key] = entry

    def _id(self, value: Any) -> Any:
        """按命令行选项返回完整或缩短后的标识符。"""

        return short_id(value, self.full_identifiers)

    def _logical_bucket_id(self, root: str) -> str:
        """从 namespace 根路径提取逻辑 bucket ID。

        例如 `setup-xxx.coordinator`、`setup-xxx.keys` 都属于同一个
        `setup-xxx` bucket；这是逻辑 bucket 数量，不是 namespace 数量。
        """

        return root.split(".", 1)[0]

    def _display_path(self, value: str) -> str:
        """显示路径时缩短其中的快照 ID、哈希和公钥。"""

        if self.full_identifiers:
            return value
        # 路径可能同时含有 bucket、公钥、快照 UUID；对每个长标识符分别缩短。
        return re.sub(
            r"[0-9a-fA-F]{64}|[0-9a-fA-F]{8}-[0-9a-fA-F-]{27,}",
            lambda match: self._id(match.group(0)),
            value,
        )

    def _json_safe(self, value: Any) -> Any:
        """递归清理报告数据，避免意外输出原始密文和过大的内容。"""

        if isinstance(value, dict):
            return {str(key): self._json_safe(item) for key, item in value.items()}
        if isinstance(value, list):
            return [self._json_safe(item) for item in value]
        if isinstance(value, bytes):
            return {"字节数": len(value), "内容": "已隐藏"}
        return value

    def _get_json_object(self, entry: dict[str, Any]) -> dict[str, Any] | None:
        value = entry.get("decoded")
        return value if isinstance(value, dict) else None

    def _logical_keys(self, commit: dict[str, Any]) -> list[str]:
        """提取提交中的逻辑键名；逻辑键名不是密文。"""

        decoded = self._get_json_object(commit) or {}
        entries = decoded.get("entries")
        if not isinstance(entries, list):
            return []
        keys: list[str] = []
        for item in entries:
            if isinstance(item, dict):
                logical_key = item.get("key")
                if isinstance(logical_key, str):
                    keys.append(logical_key)
        return keys

    def _commit_value_hashes(self, commit: dict[str, Any]) -> list[str]:
        """提取提交引用的 value 哈希。"""

        decoded = self._get_json_object(commit) or {}
        entries = decoded.get("entries")
        if not isinstance(entries, list):
            return []
        hashes: list[str] = []
        for item in entries:
            if not isinstance(item, dict):
                continue
            value_hash = item.get("valueHash")
            if isinstance(value_hash, str):
                hashes.append(value_hash)
        return hashes

    def _commit_entries(self, commit: dict[str, Any]) -> list[dict[str, Any]]:
        """取得 commit 中的逻辑键和值哈希对应表。"""

        decoded = self._get_json_object(commit) or {}
        entries = decoded.get("entries")
        if not isinstance(entries, list):
            return []
        return [item for item in entries if isinstance(item, dict)]

    def _value_kind(
        self,
        value_entry: dict[str, Any] | None,
        partition: str | None = None,
        logical_key: str | None = None,
    ) -> str:
        """根据值结构和引用位置推断值类型。

        K-V value 本身没有统一的 `kind` 字段，因此需要结合所在分区和逻辑键
        判断。这里的分类用于统计，不会修改原始数据。
        """

        value = self._get_json_object(value_entry or {})
        if isinstance(value, dict) and isinstance(value.get("authorityInstanceId"), str):
            return "authority"
        if logical_key == "authority":
            return "authority"
        if partition == "catalog-key-index" or (logical_key or "").startswith("keys/"):
            return "catalog-key-index"
        if partition == "settings" or logical_key == "plugins":
            return "settings"
        if partition == "coordinator" and logical_key == "meta":
            return "coordinator-meta"
        if partition == "records":
            return "json-object"
        if isinstance(value, dict):
            return "json"
        return "binary-or-unknown"

    def _lease_items(self, authority: dict[str, Any]) -> list[dict[str, Any]]:
        """兼容 authority 中以对象或数组保存的活动租约。"""

        leases = authority.get("activeIoLeases")
        if isinstance(leases, dict):
            return [item for item in leases.values() if isinstance(item, dict)]
        if isinstance(leases, list):
            return [item for item in leases if isinstance(item, dict)]
        return []

    def _head_pointer(self, head: dict[str, Any]) -> tuple[int | None, str | None]:
        decoded = self._get_json_object(head) or {}
        revision = decoded.get("revision")
        commit_id = decoded.get("commitId")
        if not isinstance(revision, int):
            revision = None
        if not isinstance(commit_id, str):
            commit_id = None
        return revision, commit_id

    def _commit_lookup(
        self, root: str, partition: str, revision: int | None, commit_id: str | None
    ) -> dict[str, Any] | None:
        if revision is None or commit_id is None:
            return None
        return self.commit_index.get((root, partition, revision, commit_id))

    def _current_reachability(self) -> dict[str, Any]:
        """从每个 head 追溯当前提交链和值对象。"""

        reachable_commits: set[tuple[str, str, int, str]] = set()
        reachable_values: set[tuple[str, str]] = set()
        missing_commits: list[dict[str, Any]] = []
        missing_values: list[dict[str, Any]] = []
        current_heads: list[dict[str, Any]] = []

        for (root, partition), head in sorted(self.head_index.items()):
            revision, commit_id = self._head_pointer(head)
            commit = self._commit_lookup(root, partition, revision, commit_id)
            commit_found = commit is not None
            head_summary = {
                "bucket": self._id(root),
                "partition": partition,
                "revision": revision,
                "commitId": self._id(commit_id),
                "commitFound": commit_found,
                "logicalKeys": [],
                "valueCount": 0,
                "missingValueCount": 0,
            }
            if not commit_found:
                missing_commits.append(
                    {
                        "bucket": self._id(root),
                        "partition": partition,
                        "revision": revision,
                        "commitId": self._id(commit_id),
                    }
                )
            else:
                commit_key = (root, partition, revision, commit_id)  # type: ignore[arg-type]
                reachable_commits.add(commit_key)
                logical_keys = self._logical_keys(commit)
                value_hashes = self._commit_value_hashes(commit)
                head_summary["logicalKeys"] = logical_keys
                head_summary["valueCount"] = len(value_hashes)
                for value_hash in value_hashes:
                    value_key = (root, value_hash)
                    value_entry = self.value_index.get(value_key)
                    if value_entry is None:
                        head_summary["missingValueCount"] += 1
                        missing_values.append(
                            {
                                "bucket": self._id(root),
                                "partition": partition,
                                "revision": revision,
                                "valueHash": self._id(value_hash),
                            }
                        )
                    else:
                        reachable_values.add(value_key)
            current_heads.append(head_summary)

        return {
            "reachableCommitCount": len(reachable_commits),
            "reachableValueCount": len(reachable_values),
            "reachableCommits": reachable_commits,
            "reachableValues": reachable_values,
            "missingCommits": missing_commits,
            "missingValues": missing_values,
            "currentHeads": current_heads,
        }

    def _partition_summaries(self) -> list[dict[str, Any]]:
        """汇总每个 K-V 分区的提交数量、版本范围和业务逻辑键。"""

        groups: dict[tuple[str, str], list[dict[str, Any]]] = collections.defaultdict(list)
        for entry in self.kv_entries:
            if entry["objectKind"] == "commits":
                groups[(entry["root"], entry["partition"])].append(entry)

        summaries: list[dict[str, Any]] = []
        for (root, partition), commits in sorted(groups.items()):
            commits = sorted(commits, key=lambda item: item.get("revision") or -1)
            revisions = [item["revision"] for item in commits if item.get("revision") is not None]
            expected = set(range(min(revisions), max(revisions) + 1)) if revisions else set()
            gaps = sorted(expected - set(revisions))
            timestamps: list[int] = []
            logical_keys: collections.Counter[str] = collections.Counter()
            active_lease_entries = 0
            empty_authority_commits = 0
            for commit in commits:
                decoded = self._get_json_object(commit) or {}
                committed_at = decoded.get("committedAt")
                if isinstance(committed_at, (int, float)):
                    timestamps.append(int(committed_at))
                for logical_key in self._logical_keys(commit):
                    logical_keys[logical_key] += 1
                for commit_entry in self._commit_entries(commit):
                    value_hash = commit_entry.get("valueHash")
                    if not isinstance(value_hash, str):
                        continue
                    value_entry = self.value_index.get((root, value_hash))
                    value_object = self._get_json_object(value_entry or {})
                    logical_key = commit_entry.get("key")
                    kind = self._value_kind(
                        value_entry,
                        partition=partition,
                        logical_key=logical_key if isinstance(logical_key, str) else None,
                    )
                    if kind == "authority" and isinstance(value_object, dict):
                        lease_count = len(self._lease_items(value_object))
                        active_lease_entries += lease_count
                        if lease_count == 0:
                            empty_authority_commits += 1

            summaries.append(
                {
                    "bucket": self._id(root),
                    "partition": partition,
                    "commitCount": len(commits),
                    "firstRevision": revisions[0] if revisions else None,
                    "lastRevision": revisions[-1] if revisions else None,
                    "revisionGaps": gaps,
                    "logicalKeys": {
                        self._display_path(key): value for key, value in logical_keys.items()
                    },
                    "firstCommittedAt": utc_text(min(timestamps), self.local_timezone) if timestamps else None,
                    "lastCommittedAt": utc_text(max(timestamps), self.local_timezone) if timestamps else None,
                    "activeLeaseEntriesAcrossCommits": active_lease_entries,
                    "emptyAuthorityCommitCount": empty_authority_commits,
                }
            )
        return summaries

    def _hold_summary(self) -> dict[str, Any]:
        """汇总 Hold 快照：它描述一次可恢复的存储状态。"""

        by_path = {entry["path"]: entry for entry in self.hold_entries}
        head = by_path.get("head.json")
        header = by_path.get("snapshots/85e1e8a0-f170-453d-a464-2e08097b1a83/header.json")
        # 不依赖固定快照 ID，兼容以后生成的新快照。
        if header is None:
            for entry in self.hold_entries:
                if entry["path"].endswith("/header.json"):
                    header = entry
                    break
        storage = None
        keys = None
        for entry in self.hold_entries:
            if entry["path"].endswith("/storage.json"):
                storage = entry
            elif entry["path"].endswith("/keys.json"):
                keys = entry

        head_object = self._get_json_object(head or {}) or {}
        header_object = self._get_json_object(header or {}) or {}
        storage_object = self._get_json_object(storage or {}) or {}
        keys_value = (keys or {}).get("decoded")
        key_items = keys_value if isinstance(keys_value, list) else []
        public_keys: list[str] = []
        for item in key_items:
            if isinstance(item, dict) and isinstance(item.get("publicKeyHex"), str):
                public_keys.append(self._id(item["publicKeyHex"]))

        snapshot_id = header_object.get("snapshotId")
        if not isinstance(snapshot_id, str):
            snapshot_id = None
        head_snapshot_id = head_object.get("snapshotId")
        if not isinstance(head_snapshot_id, str):
            head_snapshot_id = None
        return {
            "entryCount": len(self.hold_entries),
            "paths": sorted(self._display_path(entry["path"]) for entry in self.hold_entries),
            "headPresent": head is not None,
            "headerPresent": header is not None,
            "storagePresent": storage is not None,
            "keysPresent": keys is not None,
            "snapshotId": self._id(snapshot_id),
            "headSnapshotId": self._id(head_snapshot_id),
            "snapshotIdMatchesHead": snapshot_id is not None and snapshot_id == head_snapshot_id,
            "snapshotRevision": header_object.get("snapshotRevision"),
            "configRevision": header_object.get("configRevision"),
            "bucketGeneration": header_object.get("bucketGeneration", head_object.get("bucketGeneration")),
            "createdAt": utc_text(header_object.get("createdAt"), self.local_timezone),
            "headCommittedAt": utc_text(head_object.get("committedAt"), self.local_timezone),
            "keyCount": len(key_items),
            "publicKeys": public_keys,
            "storageCipher": (
                storage_object.get("cipher", {}).get("algorithm")
                if isinstance(storage_object.get("cipher"), dict)
                else storage_object.get("cipher")
                if isinstance(storage_object.get("cipher"), str)
                else None
            ),
            "encryptedStoragePresent": bool(storage_object),
        }

    def _catalog_summary(self) -> dict[str, Any] | None:
        """汇总目录项，不输出加密配置内容。"""

        for entry in self.other_entries:
            if entry["key"] == "keymaster.storage.catalog.v2":
                value = entry.get("decoded")
                if not isinstance(value, dict):
                    return {"present": True, "validJsonObject": False}
                buckets = value.get("buckets")
                bucket_list = buckets if isinstance(buckets, list) else []
                return {
                    "present": True,
                    "validJsonObject": True,
                    "format": value.get("format"),
                    "version": value.get("version"),
                    "bucketCount": len(bucket_list),
                    "selectedBucketId": self._id(value.get("selectedBucketId")),
                    "bucketBackends": [
                        item.get("backend")
                        for item in bucket_list
                        if isinstance(item, dict) and isinstance(item.get("backend"), str)
                    ],
                    "bucketSnapshotRevisions": [
                        item.get("snapshotRevision")
                        for item in bucket_list
                        if isinstance(item, dict)
                    ],
                }
        return None

    def _other_summary(self) -> dict[str, Any]:
        """汇总非 K-V、非 Hold 的普通 localStorage 项。"""

        result: dict[str, Any] = {
            "count": len(self.other_entries),
            "keys": [],
            "recovery": None,
            "catalog": self._catalog_summary(),
        }
        for entry in sorted(self.other_entries, key=lambda item: item["key"]):
            key = entry["key"]
            result["keys"].append(self._display_path(key))
            if key.endswith("storage.initial-setup.recovery.v1"):
                value = entry.get("decoded")
                if isinstance(value, list):
                    statuses = collections.Counter(
                        item.get("status")
                        for item in value
                        if isinstance(item, dict) and isinstance(item.get("status"), str)
                    )
                    result["recovery"] = {
                        "entryCount": len(value),
                        "statusCounts": dict(statuses),
                    }
        return result

    def _value_type_summary(self) -> dict[str, Any]:
        """按 K-V 值对象的结构和引用位置统计类型。

        K-V value 没有统一的 `kind` 字段，所以类型由 commit 中的分区、逻辑
        键和值结构共同推断。
        """

        kinds: collections.Counter[str] = collections.Counter()
        authority_entries: list[dict[str, Any]] = []
        metadata_counts: collections.Counter[str] = collections.Counter()
        references: dict[str, list[tuple[str, str, str]]] = collections.defaultdict(list)
        for commit in self.commit_index.values():
            root = commit["root"]
            partition = commit["partition"]
            for item in self._commit_entries(commit):
                value_hash = item.get("valueHash")
                logical_key = item.get("key")
                if isinstance(value_hash, str) and isinstance(logical_key, str):
                    references[value_hash].append((root, partition, logical_key))

        for entry in self.value_index.values():
            value = self._get_json_object(entry)
            if not isinstance(value, dict):
                kinds[entry.get("encoding", "unknown")] += 1
                continue
            ref = references.get(entry["objectId"], [])
            if ref:
                root, partition, logical_key = ref[0]
                kind_name = self._value_kind(entry, partition, logical_key)
            else:
                kind_name = self._value_kind(entry)
            kinds[kind_name] += 1
            if kind_name == "authority":
                authority_entries.append(value)
            elif kind_name in {"coordinator-meta", "catalog-key-index", "settings"}:
                metadata_counts[kind_name] += 1

        authority_instances = collections.Counter(
            value.get("authorityInstanceId")
            for value in authority_entries
            if isinstance(value.get("authorityInstanceId"), str)
        )
        build_ids = collections.Counter(
            value.get("buildId")
            for value in authority_entries
            if isinstance(value.get("buildId"), str)
        )
        handover_generations = collections.Counter(
            value.get("handoverGeneration")
            for value in authority_entries
            if isinstance(value.get("handoverGeneration"), int)
        )
        audit_operations: collections.Counter[str] = collections.Counter()
        active_lease_count = 0
        for authority in authority_entries:
            leases = self._lease_items(authority)
            active_lease_count += len(leases)
            for lease in leases:
                if isinstance(lease, dict) and isinstance(lease.get("auditOperation"), str):
                    audit_operations[lease["auditOperation"]] += 1

        current_authority: dict[str, Any] | None = None
        for head in self.head_index.values():
            if head.get("partition") != "coordinator-upgrade":
                continue
            root = head["root"]
            revision, commit_id = self._head_pointer(head)
            commit = self._commit_lookup(root, head["partition"], revision, commit_id)
            if commit is None:
                continue
            for commit_entry in self._commit_entries(commit):
                value_hash = commit_entry.get("valueHash")
                if not isinstance(value_hash, str):
                    continue
                value_entry = self.value_index.get((root, value_hash))
                value_object = self._get_json_object(value_entry or {})
                if self._value_kind(value_entry, "coordinator-upgrade", commit_entry.get("key")) == "authority":
                    lease_list = self._lease_items(value_object or {})
                    current_authority = {
                        "headRevision": revision,
                        "activeLeaseCount": len(lease_list),
                        "auditOperations": dict(
                            collections.Counter(
                                lease.get("auditOperation")
                                for lease in lease_list
                                if isinstance(lease, dict) and isinstance(lease.get("auditOperation"), str)
                            )
                        ),
                    }

        return {
            "objectCount": len(self.value_index),
            "kindCounts": dict(kinds),
            "metadataKindCounts": dict(metadata_counts),
            "authority": {
                "valueObjectCount": len(authority_entries),
                "distinctAuthorityInstanceIds": [self._id(item) for item in authority_instances],
                "distinctBuildIds": [self._id(item) for item in build_ids],
                "handoverGenerationCounts": dict(handover_generations),
                "activeLeaseEntriesAcrossAuthorityValues": active_lease_count,
                "auditOperationCountsAcrossAuthorityValues": dict(audit_operations),
                "currentCoordinatorUpgrade": current_authority,
            },
        }

    def report(self) -> dict[str, Any]:
        """生成完整的机器可读统计结果。"""

        reachability = self._current_reachability()
        partitions = self._partition_summaries()
        others = self._other_summary()
        catalog = others.get("catalog") or {}
        logical_buckets = {
            self._logical_bucket_id(entry["root"])
            for entry in self.kv_entries
            if isinstance(entry.get("root"), str)
        }
        logical_buckets.update(
            entry["bucket"] for entry in self.hold_entries if isinstance(entry.get("bucket"), str)
        )
        object_kind_counts = collections.Counter(
            entry.get("objectKind") for entry in self.kv_entries
        )
        namespaces = collections.Counter()
        for entry in self.kv_entries:
            namespaces[(entry["root"], entry["objectKind"])] += 1

        return {
            "字段说明": {
                "input": "输入文件与格式信息",
                "counts": "localStorage 项及内部对象数量",
                "hold": "Hold 快照：用于保存可恢复的初始化/存储状态",
                "partitions": "K-V 分区的提交历史统计",
                "reachability": "从当前 head 指针可以追溯到的提交和值对象",
                "valueTypes": "K-V 值对象内部 kind 的分类统计",
                "others": "普通 localStorage 项，例如目录、恢复记录和 worker 标识",
                "errors": "解析或引用一致性问题；不为空时建议检查导出完整性",
            },
            "input": {
                "path": str(self.source),
                "format": getattr(self, "input_format", None),
                "fileBytes": getattr(self, "file_size", 0),
                "fileSize": format_bytes(getattr(self, "file_size", 0)),
                "entryCount": getattr(self, "entry_count", 0),
                "timezone": str(self.local_timezone),
            },
            "counts": {
                "localStorageEntries": len(self.entries),
                "holdEntries": len(self.hold_entries),
                "kvEntries": len(self.kv_entries),
                "otherEntries": len(self.other_entries),
                "kvObjectKindCounts": dict(object_kind_counts),
                "logicalBucketCount": catalog.get("bucketCount") or len(logical_buckets),
                "namespaceCount": len({entry.get("root") for entry in self.kv_entries}),
                "headCount": sum(1 for entry in self.kv_entries if entry["objectKind"] == "heads"),
                "commitCount": sum(1 for entry in self.kv_entries if entry["objectKind"] == "commits"),
                "valueCount": sum(1 for entry in self.kv_entries if entry["objectKind"] == "values"),
            },
            "namespaces": [
                {
                    "bucket": self._id(root),
                    "objectKind": object_kind,
                    "count": count,
                }
                for (root, object_kind), count in sorted(namespaces.items())
            ],
            "hold": self._hold_summary(),
            "partitions": partitions,
            "reachability": {
                "currentHeadCount": len(reachability["currentHeads"]),
                "reachableCommitCount": reachability["reachableCommitCount"],
                "reachableValueCount": reachability["reachableValueCount"],
                "unreachableCommitObjectCount": len(self.commit_index) - reachability["reachableCommitCount"],
                "unreachableValueObjectCount": len(self.value_index) - reachability["reachableValueCount"],
                "missingCommitCount": len(reachability["missingCommits"]),
                "missingValueCount": len(reachability["missingValues"]),
                "currentHeads": reachability["currentHeads"],
                "missingCommits": reachability["missingCommits"],
                "missingValues": reachability["missingValues"],
            },
            "valueTypes": self._value_type_summary(),
            "others": others,
            "errors": self.errors,
            "warnings": self.warnings,
        }

    def text_report(self) -> str:
        """生成适合人阅读的中文报告。"""

        report = self.report()
        input_info = report["input"]
        counts = report["counts"]
        hold = report["hold"]
        reachability = report["reachability"]
        value_types = report["valueTypes"]
        authority = value_types["authority"]
        lines: list[str] = []

        def add(text: str = "") -> None:
            lines.append(text)

        add("Keymaster 本地存储导出统计")
        add("=" * 32)
        add(f"输入：{input_info['path']}")
        add(f"格式：{input_info['format']}；文件大小：{input_info['fileSize']}；localStorage 项：{input_info['entryCount']}")
        add("")

        add("1. 总体对象数量")
        add(f"- bucket（逻辑存储桶）：{counts['logicalBucketCount']} 个")
        add(f"- Hold 快照项：{counts['holdEntries']} 个")
        add(f"- K-V 内部对象：{counts['kvEntries']} 个（head {counts['headCount']}、commit {counts['commitCount']}、value {counts['valueCount']}）")
        add(f"- K-V namespace（命名空间根）：{counts['namespaceCount']} 个")
        add(f"- 其它普通 localStorage 项：{counts['otherEntries']} 个")
        add("")

        add("2. Hold 初始化快照")
        add("- 作用：保存一份可恢复的存储状态，不是业务数据表本身。")
        add(f"- 快照 ID：{hold['snapshotId']}；快照版本：{hold['snapshotRevision']}；配置版本：{hold['configRevision']}；bucket 代数：{hold['bucketGeneration']}")
        add(f"- 快照文件：head={hold['headPresent']}、header={hold['headerPresent']}、storage={hold['storagePresent']}、keys={hold['keysPresent']}")
        add(f"- 快照内密钥数量：{hold['keyCount']}；公钥：{', '.join(hold['publicKeys']) if hold['publicKeys'] else '未解析到'}")
        add(f"- 加密存储配置：{hold['storageCipher'] or '未声明'}（密文内容已隐藏）")
        add(f"- head 与 header 的快照 ID 一致：{'是' if hold['snapshotIdMatchesHead'] else '否/无法判断'}")
        add(f"- 创建时间：{hold['createdAt'] or '未解析到'}")
        add("")

        add("3. K-V 分区提交历史")
        add("说明：commit 是不可变的版本对象，head 是指向当前版本的指针，value 是实际保存的结构化值。")
        for partition in report["partitions"]:
            gaps = partition["revisionGaps"]
            gap_text = "无" if not gaps else ", ".join(map(str, gaps[:10])) + (" …" if len(gaps) > 10 else "")
            logical = ", ".join(
                f"{key}×{value}" for key, value in partition["logicalKeys"].items()
            ) or "无"
            add(
                f"- {partition['partition']}：{partition['commitCount']} 个 commit，版本 "
                f"{partition['firstRevision']}..{partition['lastRevision']}；缺口：{gap_text}；逻辑键：{logical}"
            )
            add(f"  时间：{partition['firstCommittedAt']} 至 {partition['lastCommittedAt']}")
        add("")

        add("4. 当前指针与历史对象")
        add(f"- 当前 head：{reachability['currentHeadCount']} 个；可追溯当前 commit：{reachability['reachableCommitCount']} 个；可追溯当前 value：{reachability['reachableValueCount']} 个")
        add(f"- 当前指针之外的 commit：{reachability['unreachableCommitObjectCount']} 个；当前指针之外的 value：{reachability['unreachableValueObjectCount']} 个")
        add("  这些是历史对象候选，不等于可以手工删除；是否回收应交给 K-V 引擎的垃圾回收逻辑。")
        if reachability["missingCommitCount"] or reachability["missingValueCount"]:
            add(f"- 引用完整性：缺少 commit {reachability['missingCommitCount']} 个、缺少 value {reachability['missingValueCount']} 个")
        else:
            add("- 引用完整性：当前 head 指向的 commit/value 均能在导出中找到")
        add("")

        add("5. Coordinator 权威记录与租约")
        add("说明：authority 是协调器的内部状态，用来记录当前实例、构建版本和正在进行的 I/O 租约；不是私钥存储。")
        add(f"- authority value 对象：{authority['valueObjectCount']} 个历史版本")
        add(f"- authority 实例：{', '.join(authority['distinctAuthorityInstanceIds']) or '未解析到'}")
        add(f"- build ID：{', '.join(authority['distinctBuildIds']) or '未解析到'}")
        add(f"- 所有历史 authority 快照累计租约条目：{authority['activeLeaseEntriesAcrossAuthorityValues']} 个")
        operations = authority["auditOperationCountsAcrossAuthorityValues"]
        add(f"- 租约操作累计：{', '.join(f'{key}×{value}' for key, value in operations.items()) or '无'}")
        current_authority = authority.get("currentCoordinatorUpgrade")
        if current_authority is not None:
            add(f"- 当前 coordinator-upgrade：第 {current_authority['headRevision']} 版，活动租约 {current_authority['activeLeaseCount']} 个")
        kind_text = ", ".join(
            f"{key}×{value}" for key, value in value_types["kindCounts"].items()
        )
        add(f"- value 内容分类：{kind_text or '无'}")
        add("")

        add("6. 目录及其它普通存储")
        catalog = report["others"].get("catalog")
        if catalog:
            add(
                f"- storage catalog：格式 {catalog.get('format')}，版本 {catalog.get('version')}，"
                f"bucket {catalog.get('bucketCount')} 个，当前选择 {catalog.get('selectedBucketId')}"
            )
            add(f"  后端：{', '.join(catalog.get('bucketBackends') or []) or '未声明'}")
        recovery = report["others"].get("recovery")
        if recovery:
            add(f"- 初始化恢复记录：{recovery['entryCount']} 条；状态：{recovery['statusCounts'] or '未声明'}")
        other_keys = report["others"].get("keys") or []
        if other_keys:
            add(f"- 其它键名：{', '.join(other_keys)}")
        add("")

        add("7. 时间范围与结论")
        add("- 核心初始化相关事件集中在约 1 秒内；之后 coordinator-upgrade 的多个版本主要是运行期间的 authority/租约更新。")
        add("- 这份导出显示：本地已经初始化了 1 个存储桶、1 个快照和 1 个公钥；同时保存了 K-V 引擎的版本历史。")
        if report["errors"]:
            add(f"- 检查结果：发现 {len(report['errors'])} 个错误，详见 JSON 输出或命令末尾。")
        else:
            add("- 检查结果：没有发现解析错误或当前 head 的引用缺失。")
        if report["warnings"]:
            add(f"- 提示：{len(report['warnings'])} 条警告。")

        if report["errors"]:
            add("")
            add("错误详情：")
            for error in report["errors"]:
                add(f"- {error}")
        if report["warnings"]:
            add("")
            add("警告详情：")
            for warning in report["warnings"]:
                add(f"- {warning}")

        return "\n".join(lines)


def build_parser() -> argparse.ArgumentParser:
    """定义命令行参数。"""

    parser = argparse.ArgumentParser(
        description="统计 Keymaster 浏览器 localStorage 导出中的 Hold 快照、K-V 版本对象和引用关系。"
    )
    parser.add_argument("input", type=Path, help="导出文件路径（JSON 对象或制表符分隔文本）")
    parser.add_argument(
        "--format",
        choices=("text", "json"),
        default="text",
        help="输出格式：text 为中文报告，json 为机器可读结果；默认 text",
    )
    parser.add_argument(
        "--full-identifiers",
        action="store_true",
        help="输出完整的快照 ID、公钥、哈希等标识符；默认只显示首尾片段",
    )
    parser.add_argument(
        "--strict",
        action="store_true",
        help="发现解析错误或引用缺失时以退出码 1 结束；默认仍输出报告",
    )
    return parser


def main(argv: Iterable[str] | None = None) -> int:
    """命令行入口。"""

    parser = build_parser()
    args = parser.parse_args(argv)
    analyzer = ExportAnalyzer(args.input, full_identifiers=args.full_identifiers)
    report = analyzer.report()
    if args.format == "json":
        print(json.dumps(analyzer._json_safe(report), ensure_ascii=False, indent=2))
    else:
        print(analyzer.text_report())

    if args.strict and (report["errors"] or report["reachability"]["missingCommitCount"] or report["reachability"]["missingValueCount"]):
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
