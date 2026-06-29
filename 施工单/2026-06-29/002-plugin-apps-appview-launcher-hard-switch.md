# 002 plugin-apps + appView launcher 硬切换一次性迭代施工单

## 参考文档与现状代码

本次施工、联调、验收以下列文档与代码为准：

- `施工单/2026-06-29/001-session-window-app-view-and-virtual-storage-hard-switch.md`
- `docs/keymaster-protocol-common-v1-draft.md`
- `docs/keymaster-connect-v1-draft.md`
- `docs/keymaster-storage-v1-draft.md`
- `packages/contracts/src/protocol.ts`
- `packages/contracts/src/plugin.ts`
- `packages/contracts/src/home.ts`
- `packages/plugin-protocol/src/protocolService.ts`
- `packages/plugin-protocol/src/sessionWindowBootstrap.ts`
- `packages/plugin-protocol/src/manifest.ts`
- `packages/plugin-vault/src/vaultService.ts`
- `packages/plugin-home/src/manifest.ts`
- `apps/web/src/bootstrapPlugins.ts`

发生冲突时：

1. 本单关于 `plugin-apps`、launcher 入口、app 清单 JSON 与首页挂载的定义优先。
2. 本单未覆盖的 Session Window / `connect.launch` / `storage.*` 语义，继续以 `2026-06-29/001` 与 `docs` 为准。
3. 后续若再改 app launcher 行为，必须先改本单与 `docs`，再改 contract、实现、测试，不允许只改代码。

---

## 1. 本单定位

本单不是“先做一个静态 apps guide 页面，以后再想办法接启动链路”的过渡方案。

本单定义的是一次**硬切换**：

- 新增 `plugin-apps`，它不是纯 guide 插件，而是 **Keymaster 内部 app launcher 插件**；
- `plugin-apps` 负责把本地 JSON 里的 app 清单展示到：
  - `/apps` 页面
  - 首页 `home.registry` widget
- 用户点击 `Open App` 时，**就在当前 Keymaster 窗口作为 launcher** 发起完整 `appView` 启动；
- `connectSessionId` 在点击 `Open App` 时**立即预建**，不是等 client app 发 `connect.launch` 才创建；
- `plugin-apps` **不**自己拼 Session Window 协议细节，这些细节统一收口到 `protocol.service` 新增的 launcher 高层入口；
- 首个 app 固定为 `https://justnote.apps.bsv8.com/`。

本单目标不是做一个“应用介绍页”，而是把“首页 app 卡片 -> 新 Session Window -> client app 首登”这条真实启动链路一次性打通。

---

## 2. 简述缘由

### 2.1 `connectSessionId` 的创建时机已经有单真值，不能漂

`2026-06-29/001` 已经明确：

1. launcher 点击启动 app 时先创建新的 `connectSessionId`；
2. 再生成 `launchToken`；
3. 再打开 Session Window；
4. client app 首条 request 才是 `connect.launch`。

因此：

- `connect.launch` 的职责是**消费 launchToken，接上已存在的 connect session**；
- 它**不是**“临时补建 session”的入口。

如果把 session 创建拖到 client app 里，当前协议关于：

- `storage.*` namespace 真值
- `ownerPublicKeyHex`
- appView bootstrap 内容
- launcher fail-closed 语义

都会错位。

### 2.2 `plugin-apps` 不能自己发明第二套 launcher 协议

当前代码里已经有：

- Session Window 唯一入口 `/protocol/v1/popup`
- `boot=appView`
- launcher bootstrap registry
- `vault.exportUnlockRuntimeForSessionWindow()`
- Session Window 端 `awaitLauncherBootstrap()`
- client app 首登 `connect.launch`

缺的不是“底层原料”，而是一个**对普通业务插件可调用的 launcher 高层能力**。

如果 `plugin-apps` 自己去直接操作：

- `protocolStorageDb`
- `buildAppBootstrapPayload()`
- `installLauncherBootstrapRegistry()`
- `window.open("/protocol/v1/popup?...")`

那就等于把协议真值散落进业务插件。后面每新增一个 app 或调整一次 bootstrap 字段，都要同时改 `plugin-apps` 与 `plugin-protocol`，系统很快失控。

### 2.3 app 清单真值应该简单地落在插件目录 JSON

这版需求不是做“应用商店后台”，也不是做“远端分发 catalog”。

当前最合理的真值模型就是：

- app 清单放在 `plugin-apps` 自己目录里
- 用一个简单 JSON 数组
- 首个 app 只有 `justnote`

这样：

- 删除插件时真值一起删除；
- 不需要额外 DB；
- 不需要网络依赖；
- 改一条 app 记录的成本最低。

### 2.4 首页挂载是必须的，不要再做第二个“商店主页”

用户已经明确要求：

- 插件要注册到 Keymaster 首页上；
- 点击首页入口就能启动 app。

因此这版不应该再额外做一个“独立应用商店首页”来绕一次。

最小可行做法就是：

- 首页 widget 展示 app 卡片摘要；
- `/apps` 页面展示完整列表；
- 两处都调用同一条 launcher 能力。

---

## 3. 最终目标

本次完成后，系统必须达到以下状态：

1. 新增 `plugin-apps` 插件，作为系统内 app launcher。
2. `plugin-apps` 从本地 JSON 读取 app 清单，首个 app 为 `https://justnote.apps.bsv8.com/`。
3. `plugin-apps` 注册：
   - `/apps` 页面
   - 菜单入口
   - 首页 `home.registry` widget
4. 用户在 `/apps` 页面或首页 widget 点击 `Open App` 时，当前 Keymaster 窗口作为 launcher 立即启动 appView 流程。
5. 点击 `Open App` 时就创建新的 `connectSessionId`，不是等 client app 发 `connect.launch` 才创建。
6. `plugin-apps` 自己不处理 bootstrap 细节；统一调用 `protocol.service` 的 launcher 高层入口。
7. `protocol.service` 新增 launcher 高层入口，内部统一完成：
   - 校验当前是否允许启动
   - 创建新的 `connectSessionId`
   - 导出 unlock runtime handoff
   - 生成 `launchToken`
   - 安装一次性 bootstrap registry
   - 打开新的 Session Window
8. Session Window 仍然只有 `/protocol/v1/popup` 这一条入口；不新增第二套路由承载 appView。
9. client app 首次登录仍然只能走 `connect.launch`；`plugin-apps` 不改变现有 client app 协议。
10. 启动失败按 fail-closed 收口：失败就失败，不补偿，不自动回退，不半启动。

---

## 4. 单真值定义

### 4.1 插件命名

本次固定：

```txt
plugin-apps
  = Keymaster 内部 app launcher 插件
  = 不是纯静态 guide 插件
```

关键约束：

1. 本次不再新增或保留 `plugin-apps-guide` 名称。
2. 目录、包名、manifest id、bootstrap import 统一使用 `plugin-apps` / `apps`。

### 4.2 App 清单真值

本次固定：

```txt
plugin-apps/src/appsCatalog.json
  = app 清单唯一真值
```

V1 每个 app 至少包含：

```txt
id
name
summary
appOrigin
appUrl
claims
```

首条记录固定包含：

```txt
id        = "justnote"
name      = "Justnote"
appOrigin = "https://justnote.apps.bsv8.com"
appUrl    = "https://justnote.apps.bsv8.com/"
```

关键约束：

1. `appOrigin` 必须是 exact origin。
2. `appUrl` 必须是 client app 真正打开的 URL。
3. `appOrigin` 与 `appUrl.origin` 不一致时，一律视为配置错误。

### 4.3 Launcher 窗口

本次固定：

```txt
launcher window
  = 用户当前点击 plugin-apps 中 "Open App" 的那个 Keymaster 窗口
```

关键约束：

1. 当前窗口就是 launcher，不再额外引入新中间窗口。
2. launcher 只负责启动与 handoff，不承担 app 运行期 owner。

### 4.4 `connectSessionId` 创建时机

本次固定：

```txt
用户点击 Open App
  => launcher 立即创建新 connectSessionId
  => 再生成 launchToken
  => 再打开 Session Window
```

关键约束：

1. `connect.launch` 不创建 session。
2. `connect.launch` 只消费 `launchToken` 并接上已存在 session。

### 4.5 Launcher 高层能力

本次固定：

```txt
protocol.service.launchAppView(...)
  = plugin-apps 唯一允许调用的 appView 启动入口
```

它的职责是：

1. 校验当前 launcher 是否允许启动；
2. 创建 connect session；
3. 解析 claims 快照；
4. 导出 unlock runtime；
5. 生成 `launchToken`；
6. 安装 bootstrap registry；
7. 打开新的 Session Window；
8. 返回启动结果或抛错。

---

## 5. 不能怎么做

1. 不能把 `plugin-apps` 做成纯静态介绍页，然后把“真正启动链路”留到以后。

2. 不能让 `plugin-apps` 自己直接 import / 操作：
   - `protocolStorageDb`
   - `buildAppBootstrapPayload`
   - `installLauncherBootstrapRegistry`
   - `window.open("/protocol/v1/popup?...")`

3. 不能把 `connectSessionId` 的创建拖到 client app 的 `connect.launch`。

4. 不能新增第二套 appView 路由，比如：
   - `/apps/view`
   - `/app-launcher`
   - `/protocol/v1/app`

5. 不能做“Open App 失败后自动回退 connect.login”之类的隐式兼容路径。失败就失败。

6. 不能把 app 清单真值放进：
   - `apps/web`
   - `localStorage`
   - `protocolStorageDb`
   - 独立中心化 catalog 文件

7. 不能为 V1 引入远端拉取 app catalog。当前需求不需要，增加复杂度没有收益。

8. 不能点击 `Open App` 时先盲目打开 Session Window，再在里面补 launcher 检查。launcher 条件不满足时必须直接拒绝启动。

9. 不能让首页 widget 和 `/apps` 页面各自维护两套启动逻辑。二者必须共用同一个 launcher 调用入口。

10. 不能把“当前全局 active key”当作 client app 运行期真值继续向下漂。app 启动后的一切业务真值仍然绑定预建 session 的 `ownerPublicKeyHex`。

---

## 6. 应该怎么做

### 一、把 launcher 能力收口到 `protocol.service`

在 `packages/contracts/src/protocol.ts` 的 `ProtocolService` 上新增 launcher 高层能力，例如：

```txt
launchAppView(input: {
  appId: string
  appOrigin: string
  appUrl: string
  claims?: string[]
}): Promise<{
  sessionWindowOpened: boolean
  connectSessionId: string
  launchToken: string
}>
```

这个入口必须是 `plugin-apps` 唯一允许依赖的启动能力。

### 二、`protocol.service` 内部统一完成完整 launcher 流程

`plugin-protocol` 内部统一收口以下步骤：

1. 校验当前 vault 已解锁。
2. 校验存在当前可用 owner key。
3. 校验 app 配置合法：
   - `appOrigin` 是合法 origin
   - `new URL(appUrl).origin === appOrigin`
4. 解析 claims 快照。
5. 创建新的 `connectSessionId`。
6. 把该 session 写入 connect session store。
7. 调 `vault.exportUnlockRuntimeForSessionWindow()` 导出一次性交接包。
8. 生成新的 `launchToken`。
9. 组装 `AppBootstrapPayload`。
10. 在当前 launcher window 上安装一次性 bootstrap registry。
11. 打开 `/protocol/v1/popup?boot=appView&bootstrapToken=...`。
12. 若 `window.open()` 失败，按 fail-closed 报错；不做静默降级。

### 三、`plugin-apps` 只做 app 清单与 UI

`plugin-apps` 自己只负责：

1. 读取 `appsCatalog.json`。
2. 暴露 `/apps` 页面。
3. 暴露菜单入口。
4. 暴露首页 widget。
5. 点击 `Open App` 时调用 `protocol.service.launchAppView(...)`。

`plugin-apps` 不保存 app 运行期会话，不缓存 launch token，不拼 bootstrap URL。

### 四、首页与页面共享同一套 app 清单

首页 widget 与 `/apps` 页面都从同一份 JSON 读数据。

建议：

- 首页 widget 只展示前 3 张卡片；
- `/apps` 页面展示完整列表；
- `Open App` 行为完全一致；
- 不做两处不同的字段映射和不同的按钮逻辑。

### 五、首个 app `justnote` 的 V1 收口

首个 app 固定为：

```txt
appId     = justnote
appOrigin = https://justnote.apps.bsv8.com
appUrl    = https://justnote.apps.bsv8.com/
```

claims 若无额外要求，V1 采用最保守最小集合；不要预埋复杂授权模型。

### 六、错误处理坚持 fail-closed

以下情况一律直接失败，不做补偿：

1. vault 未解锁
2. 没有可用 owner key
3. app 配置不合法
4. connect session 写入失败
5. unlock runtime 导出失败
6. bootstrap registry 安装失败
7. `window.open()` 被浏览器拦截或返回 `null`

失败后：

- 不创建第二条替代路径；
- 不打开“半残 Session Window”；
- 不自动 fallback；
- 只给出清晰错误提示。

---

## 7. 特殊情况应该怎么办

### 7.1 vault 未解锁

处理原则：

- `Open App` 直接失败；
- 不允许先开 Session Window 再补解锁；
- UI 明确提示用户先解锁 Keymaster。

### 7.2 当前没有可用 active key / owner key 不 ready

处理原则：

- `Open App` 直接失败；
- 不允许在 `plugin-apps` 临时发明“二次选 key 弹窗”；
- V1 继续遵守当前平台的 owner 真值模型。

后续如果真要支持“启动 app 前选 key”，必须单独出施工单，不在本单偷渡。

### 7.3 app 配置错误

例如：

- `appUrl` 不是合法 URL
- `appOrigin` 与 `appUrl.origin` 不一致
- `id` 重复

处理原则：

- 插件加载时尽早校验；
- 错误 app 不允许启动；
- 不要因为一条配置坏掉把整个应用 host 启动打崩；
- 页面上对坏记录显示明确错误状态。

### 7.4 `window.open()` 被拦截或返回 `null`

处理原则：

- 视为启动失败；
- 不做重试；
- 不补其它 transport；
- 提示用户允许当前浏览器打开新窗口。

### 7.5 launcher 打开 Session Window 后，Session Window bootstrap 失败

处理原则：

- 继续遵守 `2026-06-29/001` 的 fail-closed 语义；
- Session Window 显示自己的失败页；
- 用户回到 `plugin-apps` 再点一次 `Open App`；
- `plugin-apps` 不负责与失败中的 Session Window 长期通信。

### 7.6 client app 首次 `connect.launch` 失败

处理原则：

- 继续按 `plugin-protocol` 既有语义 fail-closed；
- 用户重新从 Keymaster 启动 app；
- 不允许 `plugin-apps` 在背后自动补发 session 或偷偷重建 token。

### 7.7 首页 widget 与 `/apps` 页面同时启动同一个 app

处理原则：

- 允许；
- 每次点击各自创建新的 `connectSessionId`；
- 不做“同 app 全局单例窗口”约束；
- 不在 V1 引入窗口复用和抢占逻辑。

---

## 8. 文件级施工清单

下面是本次一次性迭代必须触达的文件级变更范围。

### 一、contracts

#### 1. `packages/contracts/src/protocol.ts`

新增 / 调整：

1. 为 `ProtocolService` 增加 `launchAppView(...)` 高层入口。
2. 定义 `LaunchAppViewInput` / `LaunchAppViewResult`。
3. 明确该入口是 launcher 侧能力，不是 client app 对外协议方法。
4. 注释写清楚：
   - session 在点击 `Open App` 时预建；
   - `connect.launch` 只消费 token，不创建 session。

#### 2. `docs/keymaster-protocol-common-v1-draft.md`

补充：

1. Keymaster 内部 launcher 由 `plugin-apps` 触发；
2. launcher 点击 app 卡片时预建 session；
3. `plugin-apps` 不直接参与 client app transport。

#### 3. `docs/keymaster-connect-v1-draft.md`

补充：

1. `connect.launch` 与 launcher 预建 session 的关系；
2. `connect.launch` 不是创建 session 的入口。

### 二、plugin-protocol

#### 4. `packages/plugin-protocol/src/protocolService.ts`

新增：

1. `launchAppView(...)` 实现。
2. app 配置校验逻辑。
3. connect session 预建逻辑。
4. unlock runtime 导出逻辑。
5. launch token 生成与 bootstrap payload 组装。
6. bootstrap registry 安装与 Session Window 打开逻辑。

要求：

1. 不把这套逻辑散进 React 页面组件。
2. 保持 launcher 能力为 service 纯逻辑入口。

#### 5. `packages/plugin-protocol/src/manifest.ts`

补充：

1. launcher 相关 i18n 文案；
2. 需要的话补启动错误提示文案。

#### 6. `packages/plugin-protocol/src/protocolService.test.ts`

新增测试覆盖：

1. `launchAppView()` 成功路径。
2. vault 未解锁失败。
3. app 配置非法失败。
4. `window.open()` 失败。
5. 预建 session 后，client app 通过 `connect.launch` 成功接上。

### 三、plugin-apps

#### 7. `packages/plugin-apps/package.json`

新增包定义。

#### 8. `packages/plugin-apps/tsconfig.json`

新增包 ts 配置。

#### 9. `packages/plugin-apps/src/appsCatalog.json`

新增 app 清单真值。

首条记录必须包含 `justnote`：

```txt
https://justnote.apps.bsv8.com/
```

#### 10. `packages/plugin-apps/src/catalog.ts`

新增 JSON 读取与轻量校验逻辑。

要求：

1. 只做最小校验；
2. 不引入复杂 schema 系统；
3. 不做远端加载。

#### 11. `packages/plugin-apps/src/AppsPage.tsx`

新增 `/apps` 页面。

要求：

1. 展示 app 卡片列表；
2. 提供 `Open App`；
3. 对坏配置显示错误态；
4. 不自己拼启动协议。

#### 12. `packages/plugin-apps/src/AppsHomeWidget.tsx`

新增首页 widget。

要求：

1. 注册到 `home.registry`；
2. 展示 app 摘要；
3. 点击 `Open App` 走同一 launcher 能力；
4. 提供跳转 `/apps` 的入口。

#### 13. `packages/plugin-apps/src/manifest.ts`

新增插件 manifest。

依赖至少包含：

- `route.registry`
- `menu.registry`
- `home.registry`
- `protocol.service`

要求：

1. 注册 `/apps`
2. 注册菜单入口
3. 注册首页 widget
4. 元数据走 `business` 或 `platform` 中更合理的一类

#### 14. `packages/plugin-apps/src/index.ts`

导出 manifest。

#### 15. `packages/plugin-apps/src/*.test.tsx`

新增最小测试：

1. app 清单校验；
2. 页面点击触发 launcher；
3. 坏配置展示错误。

### 四、apps/web 装配层

#### 16. `apps/web/src/bootstrapPlugins.ts`

新增：

1. import `plugin-apps`
2. 把 `plugin-apps` 加入 bootstrap 顺序

顺序要求：

- `protocolPlugin` 早于 `plugin-apps`
- 因为 `plugin-apps` 依赖 `protocol.service`

### 五、施工单与文档

#### 17. `README.md`

如有必要，补一句系统存在 `plugin-apps`，负责从首页启动外部 app。

---

## 9. 实现顺序（一次性迭代，不分阶段上线）

虽然这是硬切换，但开发时仍按下面顺序落：

1. 先改 contracts / docs，把 launcher 高层能力与 session 创建时机写死。
2. 再改 `plugin-protocol`，把 `launchAppView()` 做出来并补测试。
3. 再新增 `plugin-apps` 包与 JSON 清单。
4. 再接 `/apps` 页面、首页 widget、菜单入口。
5. 最后接 `apps/web` bootstrap，并做端到端联调。

关键约束：

1. 不允许只先上 UI 壳子，启动能力以后再说。
2. 不允许只先暴露 launcher helper 函数，但没有 `plugin-apps`。
3. 不允许只先做 `/apps` 页面，首页 widget 以后再补。

---

## 10. 最终验收清单

### 10.1 插件与装配

- [ ] 存在 `plugin-apps` 包，不再使用 `plugin-apps-guide` 命名。
- [ ] `apps/web` 已装配 `plugin-apps`。
- [ ] 应用启动后可见 `/apps` 页面入口。
- [ ] 首页出现 `plugin-apps` 注册的 widget。

### 10.2 App 清单真值

- [ ] app 清单真值在 `plugin-apps` 目录内 JSON。
- [ ] 首个 app 为 `https://justnote.apps.bsv8.com/`。
- [ ] app 配置非法时，不会打崩整个 host。

### 10.3 启动链路

- [ ] 点击首页 widget 的 `Open App` 可以发起启动。
- [ ] 点击 `/apps` 页面里的 `Open App` 可以发起启动。
- [ ] 每次点击 `Open App` 时，launcher 会先创建新的 `connectSessionId`。
- [ ] 新 Session Window 仍走 `/protocol/v1/popup?boot=appView&bootstrapToken=...`。
- [ ] Session Window bootstrap 成功后会打开 client app。
- [ ] client app 首条 `connect.launch` 可以成功接上预建 session。

### 10.4 能力边界

- [ ] `plugin-apps` 不直接操作 `protocolStorageDb`。
- [ ] `plugin-apps` 不直接安装 bootstrap registry。
- [ ] `plugin-apps` 不直接拼 Session Window URL。
- [ ] launcher 协议细节统一收口在 `protocol.service.launchAppView(...)`。

### 10.5 失败语义

- [ ] vault 未解锁时，`Open App` 直接失败，不打开半残 Session Window。
- [ ] 没有可用 owner key 时，`Open App` 直接失败。
- [ ] `window.open()` 失败时，启动直接失败。
- [ ] 不存在自动 fallback 到其它登录路径。

### 10.6 单真值一致性

- [ ] 文档、contract、service、UI 对“session 在点击 Open App 时预建”表述一致。
- [ ] 文档、contract、service、UI 对“`connect.launch` 只消费 token，不创建 session”表述一致。
- [ ] 文档、contract、service、UI 对“`plugin-apps` 是 launcher 插件，不是静态 guide 页面”表述一致。

---

## 11. 本次完成后的系统图

```txt
plugin-apps
  = 读本地 JSON app 清单
  = 注册 /apps + 首页 widget
  = 用户点击 Open App
      -> protocol.service.launchAppView(app)

protocol.service.launchAppView(app)
  = 校验 launcher 当前状态
  = 创建 connectSessionId
  = 导出 unlock runtime
  = 生成 launchToken
  = 安装 bootstrap registry
  = 打开 /protocol/v1/popup?boot=appView&bootstrapToken=...

Session Window
  = consume launcher bootstrap
  = 导入 unlock runtime
  = 打开 client app

client app
  = 首条 request: connect.launch({ launchToken })
  = 接上已预建 connect session
```

这次硬切换完成后，Keymaster 内部的 app 启动链路必须是上图这一套，不再存在“静态 app guide”和“真正 launcher”两张皮。
