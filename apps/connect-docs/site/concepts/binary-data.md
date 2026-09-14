# 二进制数据

Connect 用明确结构区分字节与普通字符串：

```ts
interface BinaryField {
  $type: "binary";  // 固定类型标记
  bytes: ArrayBuffer; // 实际字节
  mime?: string;      // 可选媒体类型
}
```

使用 `binary()`、`binaryText()`、`binaryBytes()` 和 `binaryToText()` 创建或读取字段。
`binary()` 会复制输入，调用方之后修改原缓冲区不会改变请求。

Channel 内容只接受 JSON；二进制内容应由 App 自己编码后再发布。
