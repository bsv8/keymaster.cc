# 001 Session Window 双启动模式 + App View + 虚拟存储代理硬切换一次性迭代施工单

## 参考文档与现状代码

本次施工、联调、验收以下列文档与代码为准：

- `docs/keymaster-protocol-common-v1-draft.md`
- `docs/keymaster-connect-v1-draft.md`
- `packages/contracts/src/protocol.ts`
- `packages/contracts/src/vault.ts`
- `packages/plugin-protocol/src/protocolService.ts`
- `packages/plugin-protocol/src/ProtocolPopupPage.tsx`
- `packages/plugin-protocol/src/protocolStorageDb.ts`
- `packages/plugin-protocol/src/manifest.ts`
- `packages/plugin-vault/src/vaultService.ts`
- `apps/web/src/App.tsx`
- `apps/web/src/bootstrapPlugins.ts`
- `施工单/2026-06-28/001-connect-session-bound-key-and-popup-unlock-runtime-hard-switch.md`
- `施工单/2026-06-28/002-protocol-business-methods-bind-connect-session-hard-switch.md`
- `施工单/2026-06-28/003-connect-login-reauth-and-auth-owner-arbitration-hard-switch.md`

发生冲突时：

1. 本单关于 `Session Window`、`appView` 启动、`connect.launch` 与 `storage.*` 的定义优先。
2. 本单未覆盖的既有 connect session / popup transport / unlock runtime 公共语义，继续以 2026-06-28 三份 connect 施工单与 `docs` 为准。
3. 后续若再改 `appView` / `storage` / `connect.launch` 行为，必须先改本单与 `docs`，再改 contract、实现、测试，不允许只改代码。

---

## 1. 本单定位

本单不是“在现有 popup 外面再包一层应用商店页”，也不是“先做 storage-only 特例，以后再想办法统一”的过渡方案。

本单定义的是一次**硬切换**：

- 现有 `connect popup` 与未来 `app view` **不再视为两套系统**；
- 二者统一收口为同一扇 **Keymaster Session Window**；
- 差异只允许出现在**启动顺序**，不允许出现在后续协议、后续能力面、后续服务代码；
- `storage.*` 直接并入同一套对外协议，不另起“app view 私有协议”；
- launcher window 只负责**一次性启动与 bootstrap 交接**，不再承担长期运行时 owner；
- Session Window 在 bootstrap 完成后可独立服务 client web app；launcher window 可以关闭；
- S3 物理上不做多桶，逻辑上按 `origin + ownerPublicKeyHex` 划分虚拟桶；内容透明加解密，路径名不加密。

本单目标不是引入更多窗口角色，而是把“同一类能力、同一类会话、同一类协议”收紧到一个运行时里，减少后续分叉。

---

## 2. 简述缘由

### 2.1 若把 `connect popup` 与 `app view` 分成两套，后续能力一定分裂

当前你已经明确：

- 现有 popup 后续要继续支持 `connect.*` / `cipher.*` / `identity.*`；
- 下一阶段还要新增 `storage.*`；
- app 未来不会只有“启动即登录”，还会持续请求能力。

如果此时再做一套“app view 专用运行时”，结果一定是：

- 一套 connect 协议；
- 一套 app view 协议；
- 一套 popup UI；
- 一套 app 商店 UI；
- 一套 capability 执行路径；
- 一套 storage 路径。

这会让系统长期分裂，后面每加一个方法都要决定“走哪套”，不符合本项目的简单性原则。

### 2.2 真正该分层的不是能力，而是启动顺序

你已经明确了更正确的方向：

- 不是“popup 有限权，主窗口有全权”；
- 也不是“app view 是另一套新系统”；
- 而是“同一扇 Session Window，可以被不同入口以不同顺序拉起”。

也就是说：

- `client web -> Session Window` 是旧 connect 启动顺序；
- `launcher window -> Session Window -> client web app` 是新 app view 启动顺序；
- 一旦 session 建立完成，后续不应该再有分叉。

### 2.3 launcher window 长期活着是负担，不应成为运行期单点

如果 app view 运行时一直依赖 launcher window：

- 用户必须一直保留主窗口；
- 主窗口刷新/关闭会把整个 app 会话拖死；
- 同源桥接会越来越像一套新的内部 RPC 系统；
- 运行期状态会出现“双真值”：到底是 launcher 真，还是 Session Window 真。

这与本项目“简单优先、失败就失败、不要引入长期复杂桥接”的原则相冲突。

### 2.4 `storage` 能力要求 Session Window 真正成为某个 app session 的 owner

你已经提前定义了下一阶段能力：

- Keymaster 自己配置 S3；
- app 不直接拿 S3 凭证；
- app 只看到自己的虚拟桶；
- 所有内容写入要透明加密、读取要透明解密。

这意味着外部 app 需要的不是“偶尔调一下登录器”，而是一个**持续代理该 app session 的 Keymaster 运行时**。

最自然的收口就是：

- 把现有 popup 提升为 Session Window；
- 让 `storage.*`、`cipher.*`、`identity.*`、`connect.*` 全部跑在同一扇 Session Window 里。

---

## 3. 最终目标

本次完成后，系统必须达到以下状态：

1. 现有 `connect popup` 与未来 `app view` 统一为同一套 **Session Window 运行时**。
2. Session Window 只允许两种 boot mode：`connect` 与 `appView`。
3. `connect` mode 与 `appView` mode 的差异只存在于**启动阶段**；进入已建立 session 的运行期后，协议、方法、执行路径、UI 壳必须一致。
4. `appView` mode 由 launcher window 一次性完成 bootstrap；bootstrap 成功后 launcher window 可以关闭。
5. Session Window 在 `appView` mode 下不依赖长期同源桥接，不依赖主窗口持续在线。
6. Session Window 仍然保持完整 Keymaster 运行时语义：窗口刷新/关闭后 unlock runtime 会失效，但可在当前窗口自行解锁并继续恢复会话，不要求 launcher 再回来。
7. 新增 `connect.launch` 作为 `appView` mode 的首个登录入口；成功结果形状与 `connect.login` 保持对齐。
8. 新增 `storage.put/get/list/listAll/delete` 并并入同一套协议方法族；所有 `storage.*` 均绑定 `connectSessionId`，不绑定当前全局 active key。
9. 物理上只使用单一 S3 bucket；逻辑上按 `origin + ownerPublicKeyHex` 划分虚拟桶。
10. Keymaster 只加密对象内容，不加密路径名；S3 看不到内容，但允许看到路径、文件名、对象大小、修改时间等元数据。
11. 外部 app 永远看不到：
    - launcher window 内部对象；
    - Session Window 内部 vault 私密运行时；
    - S3 物理 bucket 前缀真值；
    - Keymaster 内部 storage 内容加密 key。

---

## 4. 单真值定义

> 本段是本次硬切换的术语与行为单真值。后续实现、联调、验收都按这里，不允许口头漂移。

### 4.1 Session Window

本次固定：

```txt
Session Window
  = 现有 /protocol/v1/popup 入口所承载的唯一协议运行时窗口
  = 既可以作为旧 connect popup
  = 也可以作为新 app view
```

关键约束：

1. 本次**不新增第二套路由**承载 app view。
2. `/protocol/v1/popup` 继续是唯一窗口入口路径；语义上改称 Session Window。
3. “popup”只是窗口形态称谓，不再承载新的权限模型。

### 4.2 Boot Mode

本次固定：

```txt
bootMode = "connect" | "appView"
```

含义：

- `connect`：由外部 client web `window.open` 打开 Session Window，窗口启动后等待外部 request。
- `appView`：由 Keymaster launcher window 打开 Session Window，窗口先接收 launcher 交给它的一次性 bootstrap，再主动打开 client web app。

### 4.3 Launcher Window

本次固定：

```txt
launcher window
  = 用户当前点击应用商店卡片的那个 Keymaster 窗口
  = 只负责启动与 bootstrap
  = 不是 app 会话运行期 owner
```

关键约束：

1. launcher window 可以在 bootstrap 完成后关闭。
2. launcher window 不参与 app 会话运行期的 request 执行。
3. launcher window 不承担长期 bridge / RPC / execute 职责。

### 4.4 Virtual Storage Namespace

本次固定：

```txt
virtual namespace
  = exact origin + ownerPublicKeyHex
```

外部 app 看到的是：

```txt
relativePath = "目录01/note.md"
```

物理对象 key 是：

```txt
/{originEncoded}/{ownerPublicKeyHex}/{relativePath}
```

其中：

- `originEncoded` = exact origin 的稳定编码；建议 `base64url(origin)`。
- `ownerPublicKeyHex` = `connectSessionId` 绑定 owner，不是当前全局 active key。

### 4.5 Storage 安全边界

本次固定：

1. S3 **不可信内容**：看不到明文内容。
2. S3 **可见元数据**：允许看到路径名、文件名、对象大小、修改时间。
3. V1 **不加密路径名**，只加密对象内容。
4. 这不是缺陷，是本次为保持 `list/listAll` 简单、系统不引入额外索引的明确取舍。

---

## 5. 硬切换结论

### 一、现有 connect popup 与 app view 必须是同一套 Session Window 代码

本次固定：

```txt
一套 Session Window 运行时
  = connect popup
  = app view
```

关键约束：

1. 不允许再做一套 app view 专用 service / 专用页面 / 专用方法总线。
2. `ProtocolPopupPage` / `protocolService` 继续作为唯一协议运行时宿主。
3. `storage.*` 与未来新增能力都直接并入这套运行时，不另起“app view 专用能力层”。

### 二、允许不同的只有 boot 顺序，不允许不同的有后续执行语义

本次固定：

```txt
connect mode
  = 先开 Session Window
  = 再等 client 发 connect.login / connect.resume

appView mode
  = 先由 launcher 把 bootstrap 交给 Session Window
  = Session Window 再主动开 client app
  = client app 首请求走 connect.launch
```

关键约束：

1. 从 `connect.launch` 或 `connect.login` 成功返回 `connectSessionId` 之后，后续所有方法都必须共用同一套代码路径。
2. `connect.resume`、`cipher.*`、`identity.*`、`storage.*` 不允许区分“来自 connect mode 还是 appView mode”。

### 三、launcher 与 Session Window 只允许一次性 bootstrap consume，不允许长期 bridge

本次固定：

```txt
launcher <-> Session Window
  只发生一次性 bootstrap 交接
  不发生长期 execute / state / keepalive / reconnect RPC
```

关键约束：

1. 本次**不**做主窗口长期状态轮询。
2. 本次**不**做长期同源 `execute()` bridge。
3. 本次**不**做 launcher 关闭后 Session Window 继续回主窗口取能力。
4. launcher 的职责在 Session Window 成功 consume bootstrap capsule 后结束。

### 四、bootstrap 必须是同源直接 consume 的一次性内存交接，不允许持久化 unlock runtime

本次固定：

```txt
bootstrap
  = launcher -> Session Window 的一次性内存交接
```

本次固定：launcher 与 Session Window **不**通过 `postMessage ready/bootstrap/ack` 三段消息握手完成 bootstrap。

正确模型是：

```txt
launcher 在同源 window 上挂一次性 bootstrap capsule
Session Window 启动后直接访问 window.opener
按 bootId consume 该 capsule
consume 成功后立即删除
```

也就是：

1. launcher 生成 `bootId`；
2. launcher 在自己 `window` 上挂一次性 bootstrap registry；
3. launcher 打开 Session Window，并把 `boot=appView&bootId=...` 作为轻量启动标记传给它；
4. Session Window 启动后校验 `window.opener` 同源；
5. Session Window 直接调用 `window.opener` 上的一次性 `consumeBootstrap(bootId)`；
6. launcher 命中该 `bootId` 后返回 bootstrap 内容，并立即删除该条记录；
7. Session Window consume 成功后导入 bootstrap，建立自己的完整运行时上下文；
8. 从这一刻开始 launcher 可以关闭。

launcher 仅在以下条件成立时允许暴露并被 consume：

1. `childWindow` 存在且未关闭；
2. `childWindow.location.origin === launcher.location.origin`；
3. `bootId` 存在且尚未消费；
4. 当前 launcher 有已解锁 vault 且有 active key。

bootstrap 内容必须至少包含：

- `appId`
- `appOrigin`
- `appUrl`
- `connectSessionId`
- `ownerPublicKeyHex`
- `resolvedClaims`
- `resolvedAt`
- `launchToken`
- 当前窗口导出的**一次性 unlock runtime 交接包**

关键约束：

1. unlock runtime 交接包只允许走窗口间一次性内存交接。
2. 不允许把 unlock runtime / 私密派生材料写入：
   - `localStorage`
   - `sessionStorage`
   - `IndexedDB`
   - URL query / hash
3. `consumeBootstrap(bootId)` 必须命中即删除；同一个 `bootId` 只能成功一次。
4. bootstrap 失败必须 fail-closed；launcher 不能假装已成功启动。
5. launcher 不要求等待额外 `ack` 消息；是否成功以 `consumeBootstrap(bootId)` 是否被调用并返回成功为准。

### 五、`appView` mode 不是“无锁模式”，只是避免首次二次解锁

本次固定：

1. launcher 已解锁时，`appView` mode 的 Session Window 在首次启动时**不**要求用户再次输入密码。
2. 这是因为 launcher 在 bootstrap 阶段把当前 unlock runtime 一次性交接给了 Session Window。
3. 一旦 Session Window 自己刷新/关闭，unlock runtime 仍然会失效；此后行为与现有 connect popup 一致：
   - 当前窗口可自行走锁屏解锁；
   - 已建立的 `connectSessionId` 仍可通过 `connect.resume` 恢复；
   - 不要求 launcher 再回来。

这条约束非常关键：

- 本次不是把“unlock runtime 可以长期跨窗口续命”合法化；
- 本次只是允许同源 launcher 在启动阶段把当前会话内存态一次性交接给 Session Window。

### 六、`connect.launch` 是 `appView` mode 的唯一首登入口

本次新增：

```txt
connect.launch
  = client app 在 appView mode 下的首次登录入口
  = 消费 launchToken
  = 返回与 connect.login 对齐的登录结果
```

输入最小形状：

```ts
{
  launchToken: string;
}
```

成功结果最小形状：

```ts
{
  connectSessionId: string;
  ownerPublicKeyHex: string;
  resolvedClaims: Record<string, ResolvedClaimValue>;
  resolvedAt: number;
}
```

关键约束：

1. `connect.launch` 只允许在 `appView` mode 下使用。
2. `launchToken` 一次性消费；成功后立即失效。
3. `connect.launch` 成功后，client app 后续行为与 `connect.login` 成功后的 caller 完全一致。
4. `connect.launch` 不重新选 key，不重新认证，不再额外弹 launcher 交互。
5. `connect.launch` 失败时，client app 必须回到“重新从 Keymaster 启动 app”路径；不做复杂补偿。

### 七、`storage.*` 并入同一套协议方法族

本次新增：

- `storage.put`
- `storage.get`
- `storage.list`
- `storage.listAll`
- `storage.delete`

所有 `storage.*` 共同约束：

1. **必须**传 `connectSessionId`。
2. namespace 真值统一按：
   - `session.origin`
   - `session.ownerPublicKeyHex`
3. 外部 app 只传相对路径，不得感知 bucket / endpoint / 物理前缀。
4. Keymaster 在 Session Window 内部对写入明文自动加密，对读取密文自动解密。
5. `storage.listAll` 返回当前虚拟桶下全部相对路径，供 app 自己组目录树。

---

## 6. 具体做法

### 6.1 Session Window 入口与 boot mode

继续保留 `/protocol/v1/popup` 为唯一窗口入口路径。

实现上增加 boot mode 判定：

- 缺省 = `connect`
- launcher 打开时显式标记 = `appView`

建议实现形式：

- `pathname` 仍然固定 `/protocol/v1/popup`
- `search` 或 `hash` 增加极小 boot 标记，例如 `boot=appView`

关键约束：

1. URL 中**不**承载敏感 bootstrap 内容。
2. URL 里只允许承载“此窗口要以哪种模式启动”的轻量标记。

### 6.2 `appView` mode 启动顺序

本次固定启动顺序：

1. launcher 校验当前可启动：
   - vault 已解锁；
   - active key 存在；
   - app 注册项存在；
   - app `origin` / `appUrl` 合法。
2. launcher 先建立新的 `connectSessionId`。
3. launcher 生成一次性 `launchToken`。
4. launcher 生成 `bootId` 与 `LaunchBootstrap`，并把它们放入当前窗口的一次性 bootstrap registry。
5. launcher 打开 Session Window（`boot=appView&bootId=...`）。
6. Session Window 启动后直接从 `window.opener` consume 该 `bootId` 对应的 bootstrap。
7. Session Window 导入 bootstrap，建立自己的当前 app 会话上下文。
8. consume 成功后 launcher 可退出。
9. Session Window 自己 `window.open(appUrlWithLaunchToken, ...)` 打开 client app。
10. client app 启动后，与 Session Window 走现有 `ready -> request -> result` 传输流程；首条 request = `connect.launch`。

### 6.3 Session Window 对 client app 的传输语义

本次固定：

1. Session Window 与外部 client app 的 transport 继续沿用现有 popup 语义：
   - `ready`
   - `request`
   - `result`
   - `closing`
2. `appView` mode 不另起第二套 transport。
3. `connect.launch` 只是新的业务 method，不是新的 transport。

### 6.4 unlock runtime 交接

本次要求在 vault 层补出**内部能力**，用于同源窗口启动阶段的一次性交接：

- `exportUnlockRuntimeForSessionWindow()`
- `importUnlockRuntimeFromLauncher(...)`

设计要求：

1. 只允许在 vault 已 `unlocked` 时导出。
2. 导出的交接包必须只服务于**本次** Session Window bootstrap。
3. Session Window 导入成功后，自己的 vault service 进入与普通 `unlock()` 成功后等价的内存态。
4. 导入后不允许反向保持对 launcher 内部对象的活引用；Session Window 必须具备独立继续运行能力。

### 6.5 `connect.launch` 的状态机收口

`connect.launch` 的目标不是“建第二种 session”，而是把 appView boot 收口到既有 connect session 真值上。

固定行为：

1. `connect.launch` 先校验 `launchToken`：
   - 存在；
   - 未消费；
   - 属于当前 Session Window 当前 app 上下文；
   - caller `event.origin` 与 app 注册 origin 一致。
2. 校验失败：
   - `invalid_origin` 或 `user_rejected` / `internal_error` fail-closed；
   - 不自动降级到 `connect.login`。
3. 校验成功：
   - 返回与 `connect.login` 对齐的结果；
   - 消费 token；
   - client app 自己本地持久化 `connectSessionId`；
   - 后续同现有 `connect.resume` / `cipher.*` / `storage.*`。

### 6.6 `storage.*` 的最小 contract

#### `storage.put`

输入最小形状：

```ts
{
  connectSessionId: string;
  path: string;
  contentType?: string;
  content: BinaryField;
}
```

行为：

1. 校验 session 真值。
2. 归一化 `path`。
3. 派生物理 key。
4. 明文内容在 Session Window 内部透明加密。
5. 写入对象存储。

#### `storage.get`

输入最小形状：

```ts
{
  connectSessionId: string;
  path: string;
}
```

输出最小形状：

```ts
{
  contentType?: string;
  content: BinaryField;
  updatedAt?: number;
}
```

行为：

1. 读对象存储密文。
2. 在 Session Window 内部透明解密。
3. 返回明文。

#### `storage.list`

输入最小形状：

```ts
{
  connectSessionId: string;
  prefix: string;
}
```

输出：

- 当前虚拟桶下、给定相对前缀的相对路径列表。

#### `storage.listAll`

输入最小形状：

```ts
{
  connectSessionId: string;
}
```

输出：

- 当前虚拟桶下全部相对路径列表。

#### `storage.delete`

输入最小形状：

```ts
{
  connectSessionId: string;
  path: string;
}
```

行为：

- 删除当前虚拟桶下该对象。

### 6.7 `storage.*` 的路径规则

本次固定：

1. `path` 必须是相对路径。
2. 不允许以 `/` 开头。
3. 不允许 `..`。
4. 不允许空路径。
5. 统一使用 `/` 作为分隔符。
6. Keymaster 内部必须做 normalize；normalize 后越界直接 `invalid_request`。

### 6.8 `storage.*` 的物理前缀与透明加密

物理 key：

```txt
/{originEncoded}/{ownerPublicKeyHex}/{relativePath}
```

内容加密要求：

1. 每个对象独立随机 nonce。
2. 同一路径重复写入，密文应不同。
3. 不做块级增量，不做去重，不做路径加密。
4. storage 内容加密必须有独立 domain separation，不允许与现有 `cipher.*` 站点密钥混成同一派生域。

### 6.9 S3 配置模型

本次只支持一套全局 storage provider 配置，不做多 profile。

最小配置：

- `provider = "s3-compatible"`
- `endpoint`
- `region`
- `bucket`
- `accessKeyId`
- `secretAccessKey`
- `forcePathStyle`（可选）

配置位置：

- Keymaster 自己的设置页
- 不暴露给 client app

---

## 7. 不能怎么做

以下做法本次明确禁止：

1. **禁止**把现有 popup 和新 app view 做成两套窗口运行时。
2. **禁止**给 app view 再发明一套与 connect 并列的新协议栈。
3. **禁止**让 launcher window 在运行期继续担任长期 `execute` owner。
4. **禁止**把 unlock runtime / 私密派生材料持久化到任何长期存储。
5. **禁止**把 `connectSessionId`、storage 物理前缀、S3 凭证、storage 内容加密 key 直接暴露给 client app。
6. **禁止**按 origin / public key 建物理 bucket。
7. **禁止**把 storage 权限绑定回“当前全局 active key”。
8. **禁止**为了“更隐私”在 V1 里同步做路径名加密 + 目录索引映射；那会把系统复杂度直接拉爆。
9. **禁止**因为 Session Window 是同源页面，就让 client app 直接访问窗口内部对象；安全边界必须仍由协议方法决定。
10. **禁止**把 `connect.launch` 做成“失败时自动回退 connect.login”的隐式兼容路径；失败就失败。

---

## 8. 特殊情况与收口

### 8.1 launcher 已锁定 / 无 active key

处理：

- launcher 直接不允许启动 `appView`；
- 应用卡片“开始使用”按钮不可用；
- 不允许先开 Session Window 再在 appView 模式里补 launcher 解锁。

### 8.2 launcher 打开 Session Window 后，在 bootstrap 完成前被关闭 / 刷新

处理：

- Session Window 启动失败；
- 不建立当前 app 会话；
- 不打开 client app；
- fail-closed，用户重新从应用商店点一次。

### 8.3 Session Window bootstrap 成功后，launcher 关闭

处理：

- 允许；
- 这是正式支持路径；
- 之后 client app 只依赖 Session Window。

### 8.4 Session Window 刷新 / 关闭

处理：

1. transport 断开，client app 收到 `closing` 或等价断线。
2. 当前窗口内存里的 unlock runtime 失效。
3. 若窗口仍在（刷新后重载完成），client app 可以按现有语义重新连这扇 Session Window，并走：
   - `connect.resume`
   - 当前窗口自行解锁
4. 不要求 launcher 再回来。

### 8.5 client app 首次 `connect.launch` 前，Session Window 刷新

处理：

- 由于 `launchToken` 只存在 Session Window 当前内存上下文，此次首登失败；
- 不做复杂补偿；
- 用户重新从 Keymaster 商店启动该 app。

### 8.6 client app 已拿到 `connectSessionId` 后刷新

处理：

- 走现有 `connect.resume` 路径；
- 与旧 connect caller 一致；
- 不再区分 `connect` mode / `appView` mode。

### 8.7 storage provider 未配置 / 配置失效

处理：

- `storage.*` fail-closed；
- 对外返回 `internal_error`；
- 本地 failure reason 记成明确的 storage 配置/连接失败原因；
- 不允许偷偷降级到本地明文存储。

### 8.8 对象不存在

处理：

- 新增 `not_found` 协议错误码；
- `storage.get` / `storage.delete` 命中缺失对象时返回 `not_found`；
- 不允许把“对象不存在”混成 `internal_error`。

### 8.9 path 非法或越界

处理：

- 直接 `invalid_request`；
- 不做自动修正，不做静默截断。

### 8.10 S3 侧能看到路径名与文件名

处理：

- 这是 V1 明确接受的取舍；
- 文档必须写清楚；
- 不视为 bug。

---

## 9. 文件级施工清单

### 9.1 文档与协议说明

必须修改：

- `docs/keymaster-protocol-common-v1-draft.md`
  - 把“popup”统一上升为 Session Window 概念；
  - 新增 boot mode 语义；
  - 新增 `connect.launch` 与 `storage.*` 的公共约定；
  - 明确 appView bootstrap 只是一段启动期行为，不是长期内部 RPC。

- `docs/keymaster-connect-v1-draft.md`
  - 新增 `connect.launch`；
  - 明确 `connect.login / resume / launch` 三者边界；
  - 明确 appView mode 启动时 launcher 预建 session 的语义。

- `docs/keymaster-storage-v1-draft.md`（新增）
  - 定义 `storage.put/get/list/listAll/delete`；
  - 定义虚拟桶、路径规则、透明加解密、安全边界。

### 9.2 contract 层

必须修改：

- `packages/contracts/src/protocol.ts`
  - `PROTOCOL_METHODS` 新增：
    - `connect.launch`
    - `storage.put`
    - `storage.get`
    - `storage.list`
    - `storage.listAll`
    - `storage.delete`
  - 增加对应 `Params/Result` 类型；
  - 增加 `not_found` 错误码；
  - 增加 Session Window boot / bootstrap 相关内部类型。

- `packages/contracts/src/vault.ts`
  - 为“一次性 unlock runtime 交接”补内部 contract；
  - 明确其仅供同源 Session Window bootstrap 使用，不是长期持久能力。

### 9.3 protocol / Session Window 运行时

必须修改：

- `packages/plugin-protocol/src/protocolService.ts`
  - 统一收口 connect mode / appView mode；
  - 新增 `connect.launch` 处理；
  - 新增 `storage.*` 处理；
  - 增加 appView 当前上下文管理；
  - 增加 `launchToken` 一次性消费逻辑；
  - 增加 `not_found` 路径。

- `packages/plugin-protocol/src/ProtocolPopupPage.tsx`
  - 不再只表达“第三方站点拉起的 popup”；
  - 增加 `appView` mode 启动壳、bootstrap 等待态、打开 app 流程；
  - 继续复用同一套锁屏 / auth / feed UI。

- `packages/plugin-protocol/src/manifest.ts`
  - i18n 文案补 appView / Session Window / storage 相关文案；
  - 保持 `/protocol/v1/popup` 唯一路径定义。

- `packages/plugin-protocol/src/sessionWindowBootstrap.ts`（新增）
  - 收口 boot mode 解析、一次性 bootstrap 接口、launch token 上下文。

- `packages/plugin-protocol/src/storageObjectService.ts`（新增）
  - 收口虚拟桶 key 派生、透明加解密、S3 适配。

### 9.4 vault 与 launcher 交接

必须修改：

- `packages/plugin-vault/src/vaultService.ts`
  - 增加 unlock runtime 一次性导出 / 导入能力；
  - 保证导出只发生在当前窗口已 unlocked；
  - 保证导入后当前窗口具备独立运行能力；
  - 保证不写入长期存储。

### 9.5 Web 入口与设置页

必须修改：

- `apps/web/src/App.tsx`
  - 保持 `/protocol/v1/popup` 唯一入口；
  - 增加 boot mode 入口判断与 appView 启动壳挂载。

- `apps/web/src/bootstrapPlugins.ts`
  - 保证新增 storage 设置页 / protocol 依赖在统一 host 里装载。

- `packages/plugin-settings/src/StorageSettingsPage.tsx`（新增）
  - 新增全局 storage provider 配置页。

- `packages/plugin-settings/src/manifest.ts`
  - 注册 storage 设置页入口。

### 9.6 测试

必须新增或修改：

- `packages/plugin-protocol/src/protocolService.test.ts`
  - `connect.launch` 成功 / 失败 / token 一次性消费；
  - `storage.put/get/list/listAll/delete`；
  - `not_found`；
  - appView mode 下与既有 `connect.resume` / `cipher.*` 共享路径。

- `packages/plugin-protocol/src/ProtocolPopupPage.test.tsx`
  - appView boot 等待态；
  - bootstrap 成功后打开 client app；
  - launcher 提前关闭 fail-closed；
  - Session Window 刷新后继续自解锁 / resume。

- `packages/plugin-vault/src/vaultService.test.ts`
  - unlock runtime 导出 / 导入；
  - 不落盘；
  - launcher 关闭后 Session Window 仍可继续使用。

- `packages/plugin-settings/src/StorageSettingsPage.test.tsx`（新增）
  - storage 配置读写；
  - 非法配置拒绝；
  - 更新后 Session Window 新开实例能读到。

---

## 10. 最终验收清单

### 10.1 Session Window 统一性

1. `/protocol/v1/popup` 仍是唯一入口路径，没有新增第二套 app view 路由。
2. `connect` mode 与 `appView` mode 共用同一套 `protocolService` 与页面壳。
3. 除启动阶段外，后续 `connect.resume` / `cipher.*` / `storage.*` 不再区分两种 mode。

### 10.2 appView 启动链路

1. launcher 已解锁且有 active key 时，可以从应用卡片成功启动 `appView`。
2. launcher 在 Session Window 成功 consume bootstrap 之前关闭，启动必须失败并 fail-closed。
3. bootstrap 成功后 launcher 可以关闭，client app 仍可继续通过 Session Window 工作。
4. `connect.launch` 成功结果与 `connect.login` 结果形状一致。
5. `launchToken` 只能成功消费一次。

### 10.3 既有 connect 行为不回退

1. 旧 `client web -> window.open(Session Window) -> connect.login/resume` 流程仍可用。
2. `connect.resume` 仍然只补 unlock，不重新选 key。
3. Session Window 刷新/关闭后 unlock runtime 丢失；窗口自行解锁后仍可恢复既有 session。

### 10.4 storage 行为

1. `storage.put/get/list/listAll/delete` 全部要求 `connectSessionId`。
2. 同一 `connectSessionId` 绑定的 owner 与 origin 决定唯一虚拟桶前缀。
3. app 只能看到相对路径，看不到 bucket / endpoint / 物理前缀。
4. S3 中对象内容为密文，路径名为明文。
5. `storage.listAll` 能返回某 app 当前虚拟桶下的全部相对路径，足以让 app 自己构建文件树。
6. 对象不存在时返回 `not_found`。
7. 非法 path 返回 `invalid_request`。

### 10.5 安全边界

1. unlock runtime 没有写入 `localStorage` / `sessionStorage` / `IndexedDB` / URL。
2. client app 不能直接读到 Session Window 内部 vault 运行时对象。
3. client app 不能直接拿到 storage provider 配置、物理前缀、内容加密 key。
4. Session Window 运行期不依赖 launcher 长期在线。

### 10.6 回归

1. 既有 `ProtocolPopupPage` / `protocolService` / `vaultService` 相关单测全部通过。
2. 新增 `connect.launch` 与 `storage.*` 单测通过。
3. appView mode 与 connect mode 的共享代码路径无“只在某一模式里通过”的分叉缺陷。

---

## 11. 本单收口判断

本单完成后，系统应从“一个只适合被第三方站点临时拉起的 popup 登录器”硬切换为：

```txt
同一扇 Keymaster Session Window
  - 既能被第三方 client web 直接拉起
  - 也能被 Keymaster launcher 预置上下文后拉起
  - 既承载 connect
  - 也承载 storage
  - 后续还可承载同一套 session-bound capability
```

如果最终实现仍然出现以下任一现象，视为本单**未完成**：

1. connect popup 与 app view 仍是两套 service / 两套协议代码。
2. appView 运行期仍然要求 launcher 持续在线。
3. `storage.*` 没有并入同一套协议，而是另起窗口协议。
4. unlock runtime 被写入长期存储。
5. `storage.*` 仍按当前全局 active key 而不是 `connectSessionId` 执行。
