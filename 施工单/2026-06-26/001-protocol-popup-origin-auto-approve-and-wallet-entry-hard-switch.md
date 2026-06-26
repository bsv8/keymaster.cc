# 001 Protocol Popup 顶栏精简 + 钱包入口 + Per-Origin 自动批准硬切换施工单

## 参考需求文档

可以参考以下文档与现有实现；施工与验收以这些文档和本单“本单补充定义”合并后的结果为准：

- `docs/keymaster-protocol-v1-draft.md`
- `docs/keymaster-protocol-common-v1-draft.md`
- `docs/keymaster-cipher-v1-draft.md`
- `docs/keymaster-identity-get-v1-draft.md`
- `packages/contracts/src/protocol.ts`
- `packages/plugin-protocol/src/ProtocolPopupPage.tsx`
- `packages/plugin-protocol/src/OriginSettingsTray.tsx`
- `packages/plugin-protocol/src/protocolService.ts`

发生冲突时：

1. 现有 `docs` 已经明确写死的协议基础语义，以 `docs` 为准。
2. 现有 `docs` 还没把 popup 顶栏、钱包入口、`identity.get` / `cipher.*` 的 per-origin 自动批准钉死的，以本单为准。
3. 后续如果要改这些语义，必须先改本单与对应 `docs`，再改 contract、实现、测试，不允许只改实现。

## 目标

一次性把 protocol popup 切换到下面这套最终模型：

```txt
popup 顶栏
  只保留当前站点 + 操作按钮
  不再显示“状态: 等待下一条请求”

popup 顶栏按钮
  新增“进入钱包”
  点击后新开窗口进入 https://keymaster.cc

per-origin 自动批准
  identity.get 可按 origin 配置为“始终同意”
  cipher.encrypt / cipher.decrypt 可按 origin 配置为“始终同意”
  配置真值持久化到 origins store
  下次启动仍然有效

自动批准时机
  收到 request 后先按当前 origin 配置判断
  命中则直接执行
  未命中则继续走原有人工确认
```

本次是硬切换，不接受“先只加 UI，自动批准以后再补”“先只做内存态，重启后再说”“先把新字段塞进 command 历史里凑合”这类中间态。

## 简述缘由

1. 当前 popup 顶栏里的“状态: 等待下一条请求”对用户价值很低。真正有用的是“当前服务的是哪个站点”和“我现在可以做什么操作”。保留状态文案只是在长期常驻窗口里制造噪音。

2. “进入完整版钱包”是窗口级跳转动作，不属于协议请求本身。它应该是一个简单、明确、独立的顶栏入口，而不是复用 popup 内路由、也不是把 protocol popup 自己跳走。

3. “一直同意 账户信息获取”和“一直同意 加密解密”本质上都不是单次请求的即时决定，而是“以后这个 exact origin 再来时采用什么策略”。这类真值必须落在现有 `origins` store，而不是：
   - 塞进某条 command 历史；
   - 放到 React 本地 state；
   - 放到新的全局 settings；
   - 只靠一次会话里的内存 cache。

4. 现有项目已经有 per-origin 配置模型，`p2pkh.transfer` 和 `feepool.*` 都是这么做的。继续沿这条路扩展 `identity.get` / `cipher.*`，是最小、最稳、最容易验证的解。

5. 下次启动仍然有效，意味着“第一条请求”也必须能读到持久化配置。只靠内存 cache 不够，因为 popup 新开会话时 cache 还是空的。这个点必须一次性收口，否则 UI 看起来做完了，实际第一条请求仍然不会自动批准。

## 本单补充定义

### 一、顶栏不再展示 phase 文案

本次直接移除顶栏中的：

```txt
状态: 等待下一条请求
状态: 等待解锁
状态: 等待确认
状态: 处理中
状态: 收尾
状态: 错误
```

说明：

- 这不是“waiting 时隐藏，其他 phase 继续显示”，而是顶栏层面彻底不再承载 phase 展示。
- 正在确认、解锁、执行中的上下文，仍由当前请求面板和命令流卡片承载，不额外再在顶栏重复一份。

### 二、顶栏新增“进入钱包”按钮

按钮语义固定为：

```txt
点击后新开一个窗口
目标地址固定 https://keymaster.cc
```

要求：

- 必须使用新窗口语义，不复用当前 protocol popup。
- 不允许把当前 popup 导航到首页钱包，否则会直接丢失当前协议会话。
- 不要求和 opener 建立任何消息关系；这只是用户自助打开完整版钱包。

### 三、自动批准配置属于 per-origin 真值

本次新增两个 origin 配置字段：

```ts
identityAutoApproveEnabled: boolean;
cipherAutoApproveEnabled: boolean;
```

语义固定为：

- `identityAutoApproveEnabled = true`
  `=>` 该 origin 的 `identity.get` 默认自动批准。
- `cipherAutoApproveEnabled = true`
  `=>` 该 origin 的 `cipher.encrypt` 与 `cipher.decrypt` 默认自动批准。

明确不包括：

- `intent.sign`
- `p2pkh.transfer`
- `feepool.prepare`
- `feepool.commit`

这些方法保持现有逻辑，不借这次需求顺手扩散。

### 四、旧 origin 记录缺失新字段时，统一按 false 处理

由于 `origins` store 现有记录里还没有这两个布尔字段，本次默认规则固定为：

```txt
字段缺失
  = false
```

不做：

- 扫库迁移旧记录并回写；
- 为两个布尔字段单独升级 DB version；
- 首次读取时偷偷把旧记录立刻改写回 DB。

原因很直接：这两个字段都是“未来策略真值”，缺省关闭即可，不值得为了补默认值引入额外迁移复杂度。

### 五、自动批准必须覆盖“新开会话第一条请求”

这是本单必须补死的行为：

```txt
popup 新开
收到该 origin 第一条 request
只要 DB 里已经配置为 true
就应该命中自动批准
```

不允许退化成：

```txt
必须先打开过一次站点配置
或
必须先走一次手动确认
内存 cache 才有值
之后才自动批准
```

这类行为会让“下次启动仍然有效”变成假象。

### 六、锁定态命中自动批准时，先解锁，再自动执行

自动批准不是绕过解锁。

规则固定为：

```txt
命中自动批准配置
  且 vault 已 unlocked
    -> 直接执行

命中自动批准配置
  但 vault locked / uninitialized
    -> 先进入解锁流程
       解锁成功后直接执行
       不再进入手动确认页
```

原因：

1. “始终同意”表达的是“这个 origin 的该类请求不再需要二次确认”，不是“无需解锁”。
2. 如果锁定态解锁后又回到手动确认，那“始终同意”的语义就被破坏了。

### 七、DB 不可用时，自动批准统一失效，协议能力本身尽量继续工作

规则固定为：

```txt
storageDb 不可用
  -> identity.get 不自动批准
  -> cipher.encrypt 不自动批准
  -> cipher.decrypt 不自动批准
  -> 继续走人工确认
```

原因：

- 没有可持久化真值时，系统不能偷偷默认自动批准。
- 这类请求不像 `feepool.*` 那样依赖本地持久化状态才能执行，所以最简单的降级是“关闭自动批准，保留手动路径”。

## 硬切换结论

### 一、UI 真值集中在现有 popup 页面与现有站点配置面板

本次新增的两个复选框统一放到现有“站点配置”面板里，不另开新入口，不散落到确认页里。

这样做的原因：

1. 这是 per-origin 配置，不是单次命令态。
2. 现有面板已经承担同类职责，继续扩展最简单。
3. 不把确认页继续做成“又能处理本次请求，又能顺手改未来策略”的混合界面。

### 二、持久化真值仍然只落 `origins` store

本次不新增：

- `autoApprovals` store
- `protocol.settings` localStorage
- 系统级 settings registry
- command record 上的未来策略字段

理由：

1. 当前系统已经明确“站点策略 = per-origin 真值”。
2. 重复开一套存储只会让读取路径分叉、调试变难、兼容更脆弱。

### 三、自动批准判断收口到 service

自动批准的最终判断必须在 `ProtocolService` 收口，不能散落到 React 组件里做。

原因：

1. 是否自动批准是协议执行策略，不是展示策略。
2. React 组件层不应该承担“读 origin 配置、判断首条请求、解锁后继续自动执行”这类状态机职责。
3. 只有 service 统一收口，测试才能稳定覆盖“新会话第一条请求”“锁定态解锁后直接执行”“DB 不可用退化”等边界。

## 不能怎么做

1. 不能只删顶栏状态文案，不补“进入钱包”按钮与自动批准持久化。那只是局部 UI 调整，不是这次需求的完整收口。

2. 不能把“进入钱包”做成当前窗口跳转，或 popup 内部路由跳到首页。那会直接把协议会话窗口替换掉，违反 popup 常驻模型。

3. 不能把两个新复选框做成全局设置。用户要求的是写进 origin 对应配置，同一站点不同 origin 必须彼此独立。

4. 不能把自动批准真值写进 `ProtocolCommandRecord`。命令历史记录的是“过去发生了什么”，站点配置记录的是“以后该怎么做”，两者不能混。

5. 不能只在 UI 本地 state 里保存复选框。那样刷新、重启、新开 popup 都会丢失，与需求直接冲突。

6. 不能继续只靠 `originCache` 做同步判断，然后假设“历史载入后自然会有值”。这会让新会话第一条请求经常漏掉自动批准。

7. 不能顺手把 `intent.sign` 也并入“加密解密始终同意”。签名和加解密不是同一种风险面，需求也没要求。

8. 不能在自动批准命中后仍然先进入确认页，再由 UI 自己自动点确认。那是伪自动批准，会引入多余状态跳转和时序问题。

9. 不能因为 DB 不可用就把 `identity.get` / `cipher.*` 整体拒绝掉。当前项目原则是优先系统简单，这里最简单的降级就是“禁用自动批准，保留手动确认”。

10. 不能为了给新布尔字段补默认值而引入复杂 migration、扫库回填、版本级重建。默认 false 已足够。

## 应该怎么做

### 总体策略

一次性从下到上做四层收口：

1. contract 扩展 origin 配置字段；
2. service 收口缺省值归一化与自动批准判定；
3. popup UI 移除状态栏、增加钱包入口、扩展站点配置面板；
4. 测试覆盖新会话首条请求、锁定态、DB 不可用、旧记录缺字段等边界。

### 设计要点

#### 1. origin 配置读取必须有“归一化默认值”

虽然 `ProtocolOriginSettingsRecord` 会新增两个字段，但旧数据未必有。

因此实现里必须有统一归一化逻辑，例如：

```txt
从 DB 读到的 origin record
  -> normalizeOriginSettings(record)
  -> 补齐 identityAutoApproveEnabled=false
  -> 补齐 cipherAutoApproveEnabled=false
```

这个归一化必须统一用于：

- `getOriginSettings()`
- `getOriginSettingsCached()`
- `loadHistoryForOrigin()`
- `setOriginSettings()` 前后的 cache 刷新

不能一处补默认，另一处裸读。

#### 2. 第一条请求的自动批准判断允许异步

当前 `p2pkh` / `feepool` 为了走同步 cache 判断，已经引入了 `originCache`。

但这次 `identity.get` / `cipher.*` 更重要的目标是：

```txt
重启后第一条请求也命中持久化配置
```

因此允许在接收首条 request 后：

```txt
先读取该 origin 的配置
再决定 auto-approve 还是 manual confirm
```

这里不需要为了“必须同步判断”去引入更复杂的预热、预加载、全量扫库。

#### 3. 锁定态要记住“这个请求本应 auto-approve”

如果请求到达时命中自动批准，但 vault 还没解锁，service 必须保存这个决策真值。

后续 `resumeAfterUnlock()` 时要按这个真值分流：

```txt
auto-approved request
  -> 直接 executing

manual request
  -> 进入 confirming
```

不能解锁后把请求一律推回确认页。

#### 4. 钱包入口只做 best-effort 打开，不扩展失败恢复协议

点击“进入钱包”时：

```txt
window.open("https://keymaster.cc", "_blank", "noopener,noreferrer")
```

如果浏览器拦截弹窗或返回 `null`：

- 不为此新增 toast 系统；
- 不阻塞 popup 主流程；
- 最多做控制台日志或静默失败。

这是一个辅助手势，不值得为它引入额外复杂度。

## 特殊情况提前约定

### 情况 1：旧 origin 配置记录没有新字段

处理原则：

```txt
缺字段 = false
```

结果：

- UI 打开站点配置时复选框默认未勾选；
- 自动批准不会误触发；
- 用户一旦保存，后续记录自然带上新字段。

### 情况 2：popup 新开后第一条请求就命中自动批准

处理原则：

```txt
必须命中
```

建议实现：

- 在 request 接受路径中读取当前 origin 配置；
- 判断命中后直接进入自动执行分支；
- 不要求用户先打开一次“站点配置”。

### 情况 3：命中自动批准，但钱包当前锁定

处理原则：

```txt
先解锁
再自动执行
不再进入确认页
```

如果用户取消解锁：

- 对外仍按现有语义回 `user_rejected`；
- 不额外暴露“本来可以自动批准但你没解锁”这类新状态。

### 情况 4：DB 不可用

处理原则：

```txt
自动批准失效
手动确认继续可用
```

这里不要做：

- fail-closed 整体拒绝；
- 偷偷默认自动批准；
- 引入新的本地备份存储。

### 情况 5：用户切换 origin，站点配置面板仍然开着

处理原则：

```txt
面板跟随当前 origin 重读
```

因为 popup 是单窗口常驻、按当前 origin 服务的，站点配置入口永远只编辑“当前 origin”，不支持同时编辑多个 origin。

### 情况 6：用户点击“进入钱包”后，钱包首页再自己打开一个 protocol popup

处理原则：

```txt
两者互不耦合
```

当前 protocol popup 继续按原会话工作，不因为用户打开了完整版钱包就自动关闭、切换、转移会话。

## 文件级施工

### 一、`packages/contracts/src/protocol.ts`

修改 `ProtocolOriginSettingsRecord`，新增：

```ts
identityAutoApproveEnabled: boolean;
cipherAutoApproveEnabled: boolean;
```

要求：

1. 注释写清楚 exact origin 语义不变。
2. 注释写清楚 `cipherAutoApproveEnabled` 同时作用于 `cipher.encrypt` 与 `cipher.decrypt`。
3. 不扩展到 `intent.sign`。

### 二、`packages/plugin-protocol/src/protocolService.ts`

这是本次主要收口点。

需要补的能力：

1. 新增 origin 配置归一化函数，统一补默认值。
2. `getOriginSettings()` 返回归一化后的记录。
3. `setOriginSettings()` 写入时保留新字段，并同步刷新 cache。
4. `loadHistoryForOrigin()` 读 origin record 后写入归一化结果到 cache。
5. 为 `identity.get` / `cipher.encrypt` / `cipher.decrypt` 新增自动批准判断。
6. 自动批准判断必须覆盖“popup 新开后的第一条请求”。
7. 锁定态命中自动批准时，解锁后直接执行，不再进入确认页。
8. DB 不可用时，新自动批准路径关闭，继续人工确认。

实现约束：

1. 自动批准判断收口在 service，不进 React 组件。
2. 不新建独立 store。
3. 不把这次需求的真值混进 command 记录。
4. 不破坏现有 `p2pkh` / `feepool` 路径。

### 三、`packages/plugin-protocol/src/OriginSettingsTray.tsx`

扩展现有站点配置面板：

1. 增加“始终同意 账户信息获取”复选框。
2. 增加“始终同意 加密解密”复选框。
3. 默认值来自归一化后的 origin 配置。
4. 保存时把两个字段一起写回 service。

要求：

1. 保持现有 per-origin 编辑模型。
2. 不额外拆新面板。
3. 中文文案直接写进现有 i18n 资源，不留下英文占位。

### 四、`packages/plugin-protocol/src/ProtocolPopupPage.tsx`

顶栏调整：

1. 删除“状态”整块渲染。
2. 在现有按钮区加入“进入钱包”按钮。
3. 点击后新开窗口到 `https://keymaster.cc`。
4. 保留“站点配置”“回到最新”“关闭”现有入口。

要求：

1. 不把当前 popup 自己跳走。
2. 不引入新的顶栏状态展示替代品。
3. 现有请求面板、命令流、关闭逻辑保持原样。

### 五、`packages/plugin-protocol/src/manifest.ts`

补充本次新增文案对应的 i18n key：

- 顶栏“进入钱包”
- 站点配置里的两个新复选框文案

要求：

1. 中文文案明确，不用模糊技术术语。
2. 若已有英文 fallback 结构，保持同样格式补齐。

### 六、`packages/plugin-protocol/src/styles.css`

根据顶栏结构变化做最小样式调整：

1. 状态块移除后，保证顶栏排列自然。
2. 新按钮加入后，窄宽度下不挤爆。
3. 不借这次需求顺手大改 popup 整体视觉。

### 七、测试文件

至少补齐下面这些测试：

- `packages/plugin-protocol/src/ProtocolPopupPage.test.tsx`
- `packages/plugin-protocol/src/protocolService.test.ts`
- `packages/plugin-protocol/src/protocolStorageDb.test.ts`

需要覆盖：

1. 顶栏不再出现“状态”。
2. 顶栏出现“进入钱包”按钮。
3. 点击“进入钱包”会调用新窗口打开目标地址。
4. origin 配置 round-trip 包含两个新布尔字段。
5. 旧记录缺字段时读取结果按 false 归一化。
6. `identity.get` 命中配置时自动批准。
7. `cipher.encrypt` 命中配置时自动批准。
8. `cipher.decrypt` 命中配置时自动批准。
9. popup 新开后的第一条请求也能命中自动批准。
10. 锁定态命中自动批准时，解锁后直接执行，不再进入确认页。
11. DB 不可用时，以上三类请求退化为人工确认。
12. `intent.sign` 不受新配置影响。

## 最终验收清单

### UI 与交互

1. 打开 protocol popup，顶栏不再出现“状态: 等待下一条请求”。
2. 顶栏能看到“进入钱包”按钮。
3. 点击“进入钱包”后，会新开一个窗口进入 `https://keymaster.cc`。
4. 当前 protocol popup 不会因为点击该按钮而跳走或关闭。
5. 打开“站点配置”后，能看到：
   - “始终同意 账户信息获取”
   - “始终同意 加密解密”

### 持久化与重启

6. 对某个 origin 勾选并保存后，关闭 popup，再重新打开 popup，配置仍然存在。
7. 重新打开 popup 后，该 origin 的第一条 `identity.get` 请求就能命中自动批准。
8. 重新打开 popup 后，该 origin 的第一条 `cipher.encrypt` / `cipher.decrypt` 请求就能命中自动批准。
9. 换一个不同端口或不同 scheme 的 origin，不会错误复用前一个 origin 的配置。

### 自动批准行为

10. `identity.get` 命中新配置时，不显示确认页，直接返回成功结果。
11. `cipher.encrypt` 命中新配置时，不显示确认页，直接返回成功结果。
12. `cipher.decrypt` 命中新配置时，不显示确认页，直接返回成功结果。
13. `intent.sign` 即使同 origin 已勾选“始终同意 加密解密”，仍然继续走人工确认。

### 锁定态与异常退化

14. 钱包锁定时，若请求命中新自动批准，popup 先进入解锁。
15. 解锁成功后，该请求直接执行，不再展示确认页。
16. 若用户取消解锁，对外仍回现有拒绝语义，不新增奇怪中间态。
17. 如果 DB 不可用，`identity.get` / `cipher.*` 仍可通过人工确认正常工作，只是不会自动批准。

### 工程约束

18. 不新增新的持久化 store。
19. 不新增系统级 settings 入口。
20. 不把这两个“始终同意”真值塞进 command 历史。
21. 不把 `intent.sign`、`p2pkh.transfer`、`feepool.*` 偷偷并入这次新自动批准范围。

