# Keymaster 本地存储导出统计工具

这个工具用于重复分析浏览器导出的 Keymaster `localStorage`。它会统计：

- Hold 快照：快照 ID、版本、密钥数量和加密配置类型；
- K-V 引擎对象：`head`、`commit`、`value` 的数量；
- 每个分区的提交版本范围、逻辑键和时间；
- 当前 `head` 能追溯到哪些对象，以及哪些对象只是历史候选；
- Coordinator 的 authority、活动 I/O 租约和操作类型；
- 普通目录、恢复记录等 localStorage 项。

程序默认不输出值内容、密文、私钥或完整的公钥/哈希/UUID。需要完整标识符时可以显式传入 `--full-identifiers`。

## 使用

```bash
python3 scripts/analyze-storage-export/main.py /path/to/localStorage-export.txt
```

输出机器可读 JSON：

```bash
python3 scripts/analyze-storage-export/main.py \
  --format json \
  /path/to/localStorage-export.txt > storage-report.json
```

在自动化检查中，发现解析错误或当前指针引用缺失时返回退出码 `1`：

```bash
python3 scripts/analyze-storage-export/main.py --strict /path/to/localStorage-export.txt
```

支持的输入格式：

1. 一个 JSON 对象，键是 localStorage 键，值是 localStorage 字符串值；
2. 每行一个 `键<TAB>值` 的文本导出。

报告中的 `unreachable` 只表示“从当前 head 不可达的历史对象候选”，不能据此手工删除。是否删除应由 Keymaster K-V 引擎的垃圾回收逻辑决定。
