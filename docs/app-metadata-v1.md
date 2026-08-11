# Keymaster App Identity Proof V1

本文记录 Keymaster 当前使用的固定 Publisher App Identity、catalog 导入和
requirements 启动门禁。浏览器随机 Publisher 私钥流程已经废弃；App 运行时不读取
`keymaster.app.json`。

## 唯一真值与发行流程

App 发行人只在应用入口 `index.html` 中维护以下 meta：

```html
<meta name="keymaster-app:id" content="keymaster-connect-demo">
<meta name="keymaster-app:publisher-public-key" content="03...">
<meta name="keymaster-app:name" content="Keymaster Connect Demo">
<meta name="keymaster-app:description" content="...">
<meta name="keymaster-app:requirement" content="private-key">
<meta name="keymaster-app:requirement" content="storage">
<meta name="keymaster-app:identity-signature" content="...">
```

发行流程是三个显式步骤，CLI 不自动修改 HTML：

```sh
# 手工把输出公钥写入 index.html
keymaster-app publisher create <publisher-name>

# 手工把输出的 identity-signature meta 写入 index.html
keymaster-app app sign --publisher <publisher-name>

# 验证 HTML proof，在项目根生成 keymaster.app.json
keymaster-app app create
```

Identity signature 使用 domain `keymaster-app-identity:v1`、一个零字节和 JCS payload，
覆盖 `version`、Publisher 公钥、App `id/name/description` 和排序唯一的
requirements。V1 requirements 只接受 `private-key` 和 `storage`；`storage` 是抽象
能力，不表示 S3 provider。

`keymaster.app.json` 是 HTML proof 的 flat JSON 投影，包含相同的 `signature`，但
没有额外的文件外层签名。发行人把它手工复制进 Keymaster 本地 catalog；Keymaster
不读取 App 仓库，也不从部署站点下载它。App 运行时始终从当前 HTML meta 构造 proof。

`.keymaster.json` 另有 `identitySignature` 与 `bundleSignature`：前者就是同一 proof
签名，后者认证一次具体构建的 proof、入口和文件哈希。

## 两种 session 入口

Direct login：

1. App 从 HTML 读取 proof，通过 `connect.login.appIdentity` 提交；
2. Keymaster 验证 exact shape、公钥曲线点、JCS 签名和 requirements；
3. requirements 满足后才建立带 verified snapshot 的 session；
4. 未提交 proof 时可建立普通 session，但没有 Storage namespace，且不查询 catalog。

Keymaster launcher：

1. Apps catalog 必须含完整有效 proof；缺 proof 或验签失败的条目不可启动；
2. Keymaster 在开窗前检查 catalog proof 的 requirements；
3. Keymaster 预建 session 和一次性 launch token，并绑定 verified proof digest；
4. App 启动后通过 `connect.launch({ launchToken, appIdentity })` 提交 HTML proof；
5. Keymaster 再验签，并要求 digest 与 token/session 绑定值一致，成功后才消费 token。

运行时 proof 不能覆盖 launcher catalog 中的 origin、URL、icon、claims 或预期 identity。

## Requirements 门禁

requirements 是启动前置条件，不是权限列表：

- `private-key`：用户选定的 owner key 必须可用。appView 为保留 iOS Safari user
  activation，在 catalog 与 Storage 门禁后同步预开 `about:blank`，再异步确认 key；
  失败时关闭空窗，不导航。
- `storage`：抽象 `storage.service` 必须处于 `ready`。Direct login 未满足时返回
  `storage_unavailable`；launcher 在开窗前失败。

系统不自动重试，也不为边缘失败增加补偿状态机。修正配置后重新执行完整流程。

## Storage namespace 与签名边界

只有带 verified App Identity snapshot 的 session 才能调用 `storage.*`。namespace
继续由 `publisherPublicKeyHex + appId` 隔离，caller 不能直接传入或覆盖 publisher、
app、namespace、provider 或 credential 字段。

公开 proof 能阻止第三方修改 Publisher、App id 或 requirements，但不能阻止第三方
完整复制 proof。这是“不把 origin 写入 proof、允许同一 App 多处部署”的固有限制；
proof 认证 Publisher/App namespace，不单独认证当前网页代码。具体构建真实性由 Bundle
签名或部署信任链负责。
