# 旧版存储导出分析工具

用于排查旧版本或故障现场导出的 Keymaster `localStorage`，兼容旧 `commit`、authority
（运行权）和 I/O lease（I/O 租约）记录。当前 Storage V1 只使用 `head` 与 `value`，其现行
设计以[存储文档](../../docs/存储.md)为准。

报告默认隐藏值内容、密文、私钥和完整标识符。需要完整标识符时显式传入
`--full-identifiers`。

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

支持两种输入格式：

1. 一个 JSON 对象，键是 localStorage 键，值是 localStorage 字符串值；
2. 每行一个 `键<TAB>值` 的文本导出。

`unreachable`（当前指针不可达对象）只用于诊断，不能据此手工删除数据。
