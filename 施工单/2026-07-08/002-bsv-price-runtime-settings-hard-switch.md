# 002 plugin-bsv-price 运行时设置硬切换一次性迭代施工单

## 参考文件

本单设计、评审、实现、联调、验收以下文件与文档为准：

- `施工单/2026-07-08/001-pricecast-bsv-price-broadcast-hard-switch.md`
- `apps/web/src/pluginConfigs.ts`
- `apps/web/src/bootstrapPlugins.ts`
- `packages/contracts/src/plugin.ts`
- `packages/contracts/src/settings.ts`
- `packages/plugin-bsv-price/src/constants.ts`
- `packages/plugin-bsv-price/src/bsvPriceService.ts`
- `packages/plugin-bsv-price/src/BsvPricePage.tsx`
- `packages/plugin-bsv-price/src/manifest.ts`
- `packages/runtime/src/registries/settingsRegistry.ts`
- `packages/plugin-webrtc/src/webrtcConfig.ts`
- `packages/plugin-webrtc/src/manifest.ts`

发生冲突时，按以下优先级：

1. 本单关于“`pricePublisherPublicKeyHex` 运行时唯一真值”的定义优先。
2. 本单是硬切换；不保留“部署注入一份 + 设置页再改一份”双轨真值。
3. 系统简化优先；这是一个小型全局业务设置，不引入 DB / 迁移框架 / 远端配置中心。

---

## 1. 本单定位

本单只解决一件事：

`plugin-bsv-price` 现在虽然已经能消费广播，但 `pricePublisherPublicKeyHex`
没有运行时设置入口；用户无法在 keymaster 内部改订阅公钥，只能靠启动注入。

这不符合业务使用方式。

因此本单要求一次性把 `plugin-bsv-price` 从“部署注入即最终真值”硬切到：

- 部署注入只作为首次默认值 / seed
- 运行时设置页 `/settings/bsv-price` 承担唯一可编辑真值
- `bsv-price.service` 按该真值动态重建订阅

本单不改：

- PriceCast 协议
- HubCast 协议
- `/system/broadcast` 管理页的平台职责
- `plugin-bsv-price` 的业务页 `/bsv-price` 展示职责

---

## 2. 简述缘由

### 2.1 为什么必须改

`pricePublisherPublicKeyHex` 不是静态协议常量，而是业务运行真值。

它会因为这些现实情况变化：

- PriceCast 运营私钥轮换
- 测试环境 / 正式环境 publisher 不同
- 同一套 keymaster 需要临时切到另一台 PriceCast
- 部署人员第一次注入错了，需要在 UI 内直接修正

如果继续只靠 `manifest.config` 注入：

- 改配置必须改启动脚本或重建环境
- 用户无法从 keymaster 当前 UI 看到 / 修改真值
- “为什么 `/bsv-price` 一直空”时排障路径过长

这条真值应该有设置页。

### 2.2 为什么必须硬切换

如果这次只是“额外加一个设置页”，但继续保留 `manifest.config` 与设置页并行生效，
会立刻出现双真值问题：

- 页面显示的是设置页值
- 实际订阅可能还用部署注入值
- 重启后到底读哪份没人说得清

这种“双轨过渡”比现状更糟。

所以本次必须硬切：

- `manifest.config.pricePublisherPublicKeyHex` 不再是长期运行真值
- 它只负责给空存储提供首次 seed
- 一旦本地设置存储存在，就只读本地设置

### 2.3 为什么不放到 `/system/broadcast`

`/system/broadcast` 是平台管理页，关心的是：

- active provider
- provider 连接状态
- 广播 union
- 广播平台错误

`pricePublisherPublicKeyHex` 是 `plugin-bsv-price` 的业务配置，不是广播平台配置。

把它塞进 `/system/broadcast` 会把平台层和业务层混起来。错位。

正确位置是：

- 平台层：`/system/broadcast`
- 业务层：`/settings/bsv-price`

### 2.4 为什么不用 DB

这只是一个小型全局字符串配置：

- 1 个字段
- 不按 key scope 分
- 不需要查询
- 不需要历史
- 不需要迁移链

引入 IndexedDB 只会把问题做复杂。

本次应该直接用 `localStorage`：

- 实现最小
- 与 `plugin-webrtc` / `plugin-poker` 的全局配置模式一致
- 重启后可恢复

---

## 3. 本次硬切换后的最终真值模型

### 3.1 唯一运行时真值

`pricePublisherPublicKeyHex` 的**唯一运行时真值**定义为：

- `localStorage["bsv-price.settings"]` 里的保存值

### 3.2 部署注入的角色

`apps/web/src/pluginConfigs.ts` 当前注入的：

- `manifest.config.pricePublisherPublicKeyHex`

在本次硬切换后只承担一个角色：

- 当本地存储不存在时，作为首次 seed

它**不再**是长期运行真值。

### 3.3 首次 seed 规则

启动时按以下顺序取值：

1. 若 `localStorage["bsv-price.settings"]` 有合法值，用它
2. 否则，若 `ctx.config.pricePublisherPublicKeyHex` 合法，用它初始化本地设置并立即持久化
3. 否则，进入 `not_configured`

### 3.4 之后的读取规则

一旦本地设置已经存在，之后所有运行时读取都只看本地设置：

- `/bsv-price`
- `/settings/bsv-price`
- `bsv-price.service`

都不能再直接看 `ctx.config`。

---

## 4. 目标行为定义

### 4.1 新增设置页

必须新增：

- `/settings/bsv-price`

通过 `settings.registry` 注册。

页面展示：

- 当前 publisher 公钥 hex 输入框
- 当前实际订阅频道预览
- 校验错误提示
- 保存结果提示

不展示：

- 历史列表
- 最近改动记录
- 自动发现按钮
- “从当前钱包推断”按钮

### 4.2 保存语义

保存时：

1. 读取输入框字符串
2. `trim`
3. 转小写
4. 校验必须是 66 位压缩 secp256k1 公钥 hex
5. 校验通过后写入 `localStorage`
6. `bsv-price.service` 立即切换到新频道

### 4.3 清空语义

空字符串不是错误，而是“清空配置”。

保存空字符串后：

- 持久化空值
- `bsv-price.service` 取消当前广播订阅
- `/bsv-price` 状态进入 `not_configured`
- 当前订阅频道显示 `(not configured)`

### 4.4 频道名拼接规则

频道名固定为：

- `<pricePublisherPublicKeyHex>.pricecast.bsvusdt`

实现上继续复用：

- `buildPriceChannelId(...)`

但设置页保存前就必须把 hex 归一化成小写。

原因：

- HubCast 侧 `channelId` 前缀检查按小写 hex 定义
- 不应把“大小写不一致导致订阅不到”留到运行时排错

### 4.5 业务页语义

`/bsv-price` 仍然只是展示页。

它负责显示：

- 当前连接状态
- 当前订阅频道
- 当前快照价格

它**不**负责编辑配置。

配置编辑统一收口到：

- `/settings/bsv-price`

---

## 5. 怎么做

## 5.1 存储模型

新增一个轻量本地配置模块，建议 key：

- `bsv-price.settings`

建议 schema：

```ts
interface BsvPriceGlobalConfig {
  pricePublisherPublicKeyHex: string;
  savedAtMs: number;
}
```

约束：

- 只保存 1 个字符串字段和一个时间戳
- 读到坏 JSON / 坏 schema 时，按“没有本地配置”处理
- 规范化后再持久化

### 5.1.1 规范化规则

对输入值做统一 normalize：

1. `trim()`
2. `toLowerCase()`
3. 空串允许
4. 非空时必须：
   - 长度 66
   - 只含 `[0-9a-f]`
   - 前缀只能是 `02` 或 `03`

### 5.1.2 写入失败规则

`localStorage.setItem(...)` 失败时：

- 本次保存失败
- 当前运行中的有效配置保持旧值
- 页面提示失败
- 不能切成“仅内存成功、持久化失败”的半状态

也就是说：

- 先写存储
- 成功后再切换 service 真值

这和 `plugin-webrtc` 的保存失败回滚思想一致。

## 5.2 service 改造

`createBsvPriceService(...)` 不能再只接受一个固定字符串然后永久不变。

必须改成：

- 启动时读取本地全局配置
- 根据当前配置决定订阅哪个频道
- 对外暴露“读取当前配置 + 保存配置”的能力
- 保存成功后立即重建订阅

建议直接让 `BsvPriceService` 承担这件事，不再额外造第二个 settings service。

原因：

- 这个插件就一个核心业务对象
- 配置变更与订阅重建天然强相关
- 再拆第二个 service 没有收益，只会增加装配复杂度

### 5.2.1 service 应新增的能力

建议在现有 `BsvPriceService` 上增加：

- `getPublisherPublicKeyHex(): string`
- `savePublisherPublicKeyHex(input: string): Promise<void> | void`
- `configured(): boolean`
- `dispose(): void`

现有 `snapshot()` 也应继续保留，并保证设置变化后会触发 `subscribe(handler)`。

### 5.2.2 重建订阅语义

保存成功后：

1. 若旧频道有订阅，先取消
2. 若新值为空，不再挂新订阅
3. 若新值合法，重新 `core.subscribe({ channelIds: [newChannelId] })`
4. 更新本地状态并通知 UI

### 5.2.3 旧快照处理

切换 publisher 公钥后，旧快照不应继续显示成“当前有效价格”。

必须：

- 清空当前 `snapshot`
- 清空 `lastError`
- 让新频道从空态重新等待下一次广播

原因：

- 旧快照来自旧 publisher / 旧频道
- 继续显示会制造“看起来已经切到新源，实际还是旧数据”的错觉

## 5.3 设置页 UI

页面路径：

- `/settings/bsv-price`

注册方式：

- `settings.registry.register(...)`

页面交互建议：

1. 一个文本输入框：`PriceCast publisher 公钥 hex`
2. 一个只读预览：当前订阅频道
3. 一个保存按钮
4. 一条保存成功/失败提示

本次不做：

- 自动保存 on blur
- 多字段表单
- 恢复部署默认值按钮
- 导入/扫描按钮

原因：

- 这里只有一个关键字段
- 需要严格校验
- 显式保存最清楚，误操作最少

### 5.3.1 保存按钮语义

- 输入合法后点击保存
- 保存成功显示“已保存”
- 保存失败显示错误，不改当前真值

### 5.3.2 空值 UX

输入框清空后点击保存，不报错，直接视为：

- 清空配置

页面上要明确提示：

- 清空后 `/bsv-price` 会停止订阅并进入未配置状态

## 5.4 装配层语义

`apps/web/src/pluginConfigs.ts` 和 `bootstrapPlugins.ts` 仍然保留。

但注释和设计语义必须改成：

- 它们提供的是 seed
- 不是运行时长期真值

也就是说：

- 这两处不删
- 但边界定义要改

## 5.5 测试策略

必须补 3 类测试：

1. 本地配置存储测试
2. service 动态换 publisher 订阅测试
3. 设置页交互测试

特别要锁住这些行为：

- 空存储时从 `ctx.config` seed
- 本地存储存在时覆盖 seed
- 保存新值后旧订阅被取消、新订阅生效
- 保存空值后进入 `not_configured`
- 非法值不落库、不切订阅

---

## 6. 不能怎么做

以下做法本次明确禁止：

### 6.1 不能保留双真值

不能同时让下面两者都在运行时独立生效：

- `manifest.config.pricePublisherPublicKeyHex`
- `/settings/bsv-price` 保存值

只能有一个运行时真值。

### 6.2 不能把设置入口放到 `/system/broadcast`

`/system/broadcast` 是平台页，不是 `bsv-price` 业务设置页。

### 6.3 不能从 vault / keyspace 自动推断

不能因为用户当前 active key 是某个公钥，就自动把它当 PriceCast publisher。

这是两套完全不同的真值。

### 6.4 不能继续读 `globalThis.__PRICECAST_PUBLISHER_PUBKEY__`

`plugin-bsv-price` 自己不能再直接读全局变量。

全局变量只允许装配层读一次，桥接成 seed。

### 6.5 不能引入 IndexedDB

这是一个单字段全局设置，不值得为它开 DB。

### 6.6 不能要求重启才能生效

用户在 `/settings/bsv-price` 保存后，订阅切换必须立即生效。

### 6.7 不能保留旧快照

切换 publisher 后不能继续显示旧 publisher 的价格快照。

---

## 7. 特殊情况提前约定

### 7.1 本地存储不存在，部署 seed 存在

行为：

- 用 seed 初始化本地配置
- 立即持久化
- 进入正常订阅

### 7.2 本地存储存在，部署 seed 改了

行为：

- 忽略新的 seed
- 继续使用本地配置

原因：

- 运行时真值已经切到本地设置
- 不能因为重启把用户设置悄悄覆盖掉

### 7.3 本地存储是坏 JSON

行为：

- 视为“本地配置不存在”
- 走 seed 初始化或未配置分支

### 7.4 用户输入大写公钥

行为：

- 保存前自动转小写
- 小写值才是最终持久化真值

### 7.5 用户输入非法公钥

行为：

- 拒绝保存
- 保持旧值
- 不切换订阅

### 7.6 用户清空配置

行为：

- 允许保存
- 进入 `not_configured`
- 取消订阅
- 清空业务页快照

### 7.7 当前 broadcast provider 未就绪

行为：

- 允许保存配置
- 本地真值立即切换
- UI 频道预览立即更新
- 实际数据等待 provider 恢复后再收到

### 7.8 `localStorage` 不可用或写失败

行为：

- 保存失败
- 当前有效配置不变
- 页面提示错误

不能做：

- 只改内存，不落持久化

---

## 8. 文件级修改清单

以下是一次性实施时应修改/新增的文件。

### 8.1 装配层

- `apps/web/src/pluginConfigs.ts`
  - 保留 `bsvPriceConfig`
  - 重新定义注释：这是首次 seed，不是运行时长期真值

- `apps/web/src/bootstrapPlugins.ts`
  - 保留对 `bsvPricePlugin.config` 的注入
  - 注释改成“seed 注入”
  - 不再把它描述成最终配置真值

### 8.2 plugin-bsv-price 常量与配置

- `packages/plugin-bsv-price/src/constants.ts`
  - 更新注释：`BSV_PRICE_CONFIG_KEY` 是 seed key，不是长期真值来源
  - 可在此文件补充：
    - localStorage key 常量
    - `/settings/bsv-price` path 常量

- `packages/plugin-bsv-price/src/bsvPriceConfig.ts`（新增）
  - 负责：
    - load
    - normalize
    - validate
    - save
    - subscribe
  - 存储载体固定 `localStorage`

### 8.3 plugin-bsv-price service

- `packages/plugin-bsv-price/src/bsvPriceService.ts`
  - 从“固定 publisher 构造后不可变”改成“持有可变全局配置”
  - 新增保存配置后重建订阅能力
  - 新增 `dispose()`
  - 切 publisher 后清空旧快照

### 8.4 plugin-bsv-price 设置页

- `packages/plugin-bsv-price/src/BsvPriceSettingsPage.tsx`（新增）
  - 一个输入框
  - 一个频道预览
  - 一个保存按钮
  - 错误/成功提示

- `packages/plugin-bsv-price/src/styles.css`
  - 补设置页样式
  - 继续保持与业务页同一视觉语系

### 8.5 plugin-bsv-price manifest

- `packages/plugin-bsv-price/src/manifest.ts`
  - 增加对 `settings.registry` 的依赖声明
  - setup 时：
    - 创建本地配置 store
    - 用 `ctx.config` 作为 seed 初始化
    - 创建可动态重订阅的 `bsv-price.service`
    - 注册 `/settings/bsv-price`
  - 保留 `/bsv-price` 业务页注册

- `packages/plugin-bsv-price/src/index.ts`
  - 导出新增设置页/配置 store/类型（若外部需要）

### 8.6 测试

- `packages/plugin-bsv-price/src/manifest.test.ts`
  - 从“只测 `ctx.config` 注入”扩展为：
    - seed 生效
    - 本地配置覆盖 seed

- `packages/plugin-bsv-price/src/bsvPriceConfig.test.ts`（新增）
  - 测 normalize / validate / save / load / 坏 JSON 容错

- `packages/plugin-bsv-price/src/bsvPriceService.test.ts`（新增）
  - 测保存后重订阅
  - 测清空配置后取消订阅
  - 测旧快照被清空

- `packages/plugin-bsv-price/src/BsvPriceSettingsPage.test.tsx`（新增）
  - 测输入非法值时报错
  - 测保存合法值后提示成功

### 8.7 明确不改的文件

以下文件本次不应承载编辑入口：

- `packages/plugin-broadcast/src/manifest.ts`
- `packages/plugin-broadcast/src/BroadcastPage.tsx`
- `packages/plugin-protocol/src/protocolService.ts`
- `/home/david/Workspaces/PriceCast/*`
- `/home/david/Workspaces/HubCast/*`

---

## 9. 最终验收清单

以下清单全部满足，才算本次硬切换完成。

### 9.1 路由与页面

- [ ] 存在 `/settings/bsv-price`
- [ ] 设置页出现在 settings 分组中
- [ ] `/bsv-price` 仍存在且只负责展示
- [ ] `/system/broadcast` 不出现编辑 `pricePublisherPublicKeyHex` 的表单

### 9.2 真值与持久化

- [ ] `pricePublisherPublicKeyHex` 的运行时唯一真值是 `localStorage`
- [ ] 本地配置不存在时会从 `manifest.config` seed 初始化
- [ ] 本地配置存在时重启后仍读本地配置，不回退到 seed
- [ ] 保存空值后进入 `not_configured`

### 9.3 设置页行为

- [ ] 输入合法压缩公钥 hex 可以保存成功
- [ ] 输入大写 hex 时最终持久化为小写
- [ ] 输入非法值时拒绝保存
- [ ] 保存失败时旧值保持不变

### 9.4 订阅行为

- [ ] 保存新公钥后旧频道订阅被取消
- [ ] 保存新公钥后新频道订阅立即生效
- [ ] 保存空值后不再挂任何价格频道订阅
- [ ] 切换公钥后旧快照被清空

### 9.5 业务页与管理页

- [ ] `/bsv-price` 可显示当前订阅频道名
- [ ] 未配置时 `/bsv-price` 显示 `not_configured`
- [ ] 配置后 `/bsv-price` 能在下一次广播到达后显示价格
- [ ] `/system/broadcast` 可看到新的本地订阅 union 变化

### 9.6 自动化验证

- [ ] `pnpm exec vitest run packages/plugin-bsv-price/src/manifest.test.ts`
- [ ] `pnpm exec vitest run packages/plugin-bsv-price/src/bsvPriceConfig.test.ts`
- [ ] `pnpm exec vitest run packages/plugin-bsv-price/src/bsvPriceService.test.ts`
- [ ] `pnpm exec vitest run packages/plugin-bsv-price/src/BsvPriceSettingsPage.test.tsx`
- [ ] `pnpm typecheck`

---

## 10. 一句话收口

本次不是“再加一个设置页”，而是把 `plugin-bsv-price` 的 publisher 公钥配置从
“部署注入即最终真值”硬切到“部署注入只做 seed，`/settings/bsv-price` 才是唯一运行时真值”。

只有这样，`/bsv-price` 的业务可用性、排障路径和系统边界才会同时变清楚。
