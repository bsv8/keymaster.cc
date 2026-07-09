# 001 `/system/appmsg` 在线查询反馈与可诊断性硬切换一次性迭代施工单

## 参考文件

本单设计、评审、实现、联调、验收以下现状文件为准：

- `packages/plugin-appmsg/src/AppMsgPage.tsx`
- `packages/plugin-appmsg/src/AppMsgPage.test.tsx`
- `packages/plugin-appmsg/src/appmsgService.ts`
- `packages/plugin-appmsg/src/appmsgCore.ts`
- `packages/plugin-appmsg/src/manifest.ts`
- `packages/plugin-appmsg/src/styles.css`
- `packages/plugin-hubmsg/src/hubmsgConnection.ts`
- `packages/plugin-hubmsg/src/hubmsgConnection.test.ts`
- `packages/contracts/src/appmsg.ts`
- `施工单/2026-07-03/001-appmsg-local-truth-full-push-online-hard-switch.md`
- `施工单/2026-07-04/004-appmsg-signed-envelope-sealed-body-hard-switch.md`

发生冲突时，按以下优先级：

1. 本单关于“`/system/appmsg` 在线查询必须有明确反馈、不得静默失败”的定义优先。
2. `AppMsg` 业务侧既有 `checkOnline -> unknown` 降级语义保持不变；管理页体验修复不能反向改坏业务侧简单语义。
3. 本次是管理页硬切换，不改 `message.online` 远端协议，不改消息正文加密协议，不引入重试、补偿、双轨兼容。

---

## 1. 文档定位

本单不是在排查 `HubMsg` 在线协议兼容性，也不是借“查询在线没反应”去扩张一套新的消息诊断系统。

本单只解决一个明确问题：

- `/system/appmsg` 页面“查询在线”区域在若干失败路径上没有任何可见反馈；
- 用户无法区分“输入格式不对”“当前未连接 provider”“本次查询失败”“查询成功但结果是 offline”；
- 在 `body` 加密改造之后，这种静默路径更容易被误判为“协议报文格式坏了”。

因此本次必须一次性把管理页在线查询的交互语义硬切清楚：

1. 输入错误必须报错；
2. 查询动作必须有进行中态；
3. 成功必须显示结果；
4. 失败必须显示失败原因或明确失败态；
5. `unknown` 不能继续表现成“页面像没动过”。

---

## 2. 简述缘由

### 2.1 当前主要问题不是协议一定坏了，而是 UI 把失败吞成了“没反应”

现状里至少有两层静默：

- `AppMsgPage.tsx` 对输入做本地正则校验，失败后直接 `return`；
- `appmsgService.ts` / `appmsgCore.ts` / `hubmsgConnection.ts` 都可能把错误收敛成 `unknown`。

这会导致用户看到的表象是：

- 点按钮没反应；
- 没有错误；
- 也不清楚到底是离线、未知，还是根本没发出去。

这类问题优先级高于“是否继续深挖远端协议细节”，因为连最基本的可见反馈都没有。

### 2.2 不能因为管理页体验差，就把业务侧简单语义搞复杂

系统当前的设计取向是：

- 边缘失败允许失败；
- 业务完整性不能以显著增加系统复杂度为代价；
- 能重启恢复的事，不要在系统里塞复杂补偿。

因此本次不能把“管理页要看得见错误”误做成：

- 给 `checkOnline` 新增复杂错误枚举；
- 给 provider / core / service 补一条新诊断协议；
- 为了分辨所有失败原因而改动业务插件依赖的公共 contract。

正确做法是：

- 仅在管理页收口用户可见反馈；
- 复用现有 `lastError`、`state`、`unknown` 等已有真值；
- 保持业务侧继续拿到简单的 `online | offline | unknown`。

### 2.3 不能把“body 加密后出现问题”直接推导成 `message.online` 协议被改坏

根据当前实现，`message.online` 仍是独立 RPC：

- 入参是 `publicKeyHex[]`
- 出参是在线 `publicKeyHex[]`

它不走消息正文密封/解密链路。

所以本次设计不能在证据不足时直接：

- 改 `HubMsgWireOnlineParams`
- 改 `HubMsgWireOnlineResult`
- 改 `plugin-hubmsg` 的 online 编解码
- 为“可能是报文格式不匹配”加兼容分支

这会把一个管理页反馈问题误升级成协议问题，复杂度方向错了。

---

## 3. 本次硬切换后的最终状态

本次完成后，`/system/appmsg` 的在线查询区必须满足以下最终状态：

1. 输入非法公钥时，页面立即显示明确错误，不再静默返回。
2. 用户点击“查询在线”后，页面出现进行中反馈，按钮在请求完成前不可重复点击。
3. 查询成功时，无论结果是 `online` 还是 `offline`，页面都显示明确结果。
4. 查询返回 `unknown` 时，页面显示“未知/查询失败类反馈”，不再表现成“没有结果”。
5. 当前 `appmsg` 未连接、provider 未就绪或 owner 不可用时，页面给出明确失败提示。
6. 页面支持从上一次失败态恢复到下一次成功态；旧错误不会粘住后续成功展示。
7. 本次只修管理页反馈，不改 `webrtc` 等业务插件对 `checkOnline` 的既有依赖语义。
8. 本次不修改 `message.online` 远端协议，不做 wire 兼容，不引入重试。

---

## 4. 单一设计原则

### 4.1 管理页只消费已有真值，不发明新的系统层错误协议

本次管理页允许使用的真值来源只有：

- 输入框本地校验结果；
- `service.checkOnline(...)` 返回值；
- `core.inspectLocalDb()` 提供的连接状态与 `lastError`；
- 已有的 `unknown` 降级语义。

本次**不允许**新增以下方向：

- `checkOnlineDetailed(...)`
- `AppMsgOnlineErrorCode`
- provider/core/service 多层透传复杂 typed error
- 专门为管理页新增一个“在线诊断 RPC”

### 4.2 `unknown` 在业务层保持简单，在管理页必须可见

业务层语义继续保持：

- `online`：对方当前在线
- `offline`：对方当前离线
- `unknown`：未能确认

但在管理页展示上，`unknown` 不能再等价于“无反馈”。

管理页必须把 `unknown` 解释为一种需要展示的可见结果，且配合当前连接态 / 最近错误给出足够让人判断的文案。

### 4.3 用户主动触发的动作，不能吞错

和“手动同步”一样，“查询在线”也是用户主动点按钮的动作。

所以本次界面层必须遵守：

- 能在本地判定的错误，直接显示；
- 能在本页拿到的失败上下文，直接显示；
- 不允许点击后因为代码 `return` 或失败降级而完全无可见变化。

---

## 5. 要怎么做

### 5.1 在 `AppMsgPage` 的在线查询区补齐显式状态机

在线查询区收敛成最小可用状态：

- `idle`
- `loading`
- `success`
- `error`

建议以页面局部 state 实现，不上升到全局 store，不抽象成通用 hook。

最低要求：

- 新查询开始时清理上一轮结果/错误；
- 请求进行中按钮禁用；
- 请求完成后根据结果进入成功或失败展示；
- 输入变化时可保留或清理旧态，但最终不能出现“旧错误压住新结果”。

### 5.2 输入校验失败要本地报错

对 `publicKeyHex` 的本地校验继续保留最小规则：

- 必须是 66 位 hex

但行为改为：

- 不再 `return` 后无提示；
- 直接进入错误态并显示文案。

这类错误属于纯本地错误，不调用 service，不污染 core 状态，不写系统复杂逻辑。

### 5.3 查询结果必须区分三类展示

本次 UI 至少区分：

1. `online`
2. `offline`
3. `unknown / failed`

其中第三类展示要满足：

- 即使底层 contract 只有 `unknown`，管理页也要给出“无法确认/查询失败”的说明；
- 若当前 `inspectLocalDb().state !== "open"`，优先展示“当前消息服务未连接”类提示；
- 若 `lastError` 有值，可把它作为辅助信息展示；
- 若没有更具体上下文，也要有通用失败提示。

### 5.4 service 层为管理页提供“可见失败”而不是继续完全吞掉

本次建议把 `createAppMsgService(core)` 的在线查询语义改成：

- 默认不再额外吞掉异常后静默只回 `unknown`；
- 让 UI 有机会进入自己的失败反馈分支。

但要注意边界：

- 这是管理页私有 service；
- 不是改公共 `AppMsgCore` contract；
- 不是改业务插件依赖的 endpoint service 语义。

如需兼顾现有 core 仍返回 `unknown` 的路径，UI 也必须对“无异常但结果是 `unknown`”提供失败类反馈。

### 5.5 只补最小样式，不重做整页结构

本次样式改动只允许服务于以下目标：

- 查询中态可见
- 错误文案可见
- 结果列表与错误提示区块可分辨

不允许借机：

- 重做 `/system/appmsg` 整页布局
- 新造复杂视觉组件
- 改无关区块样式

---

## 6. 明确不能怎么做

### 6.1 不能把这次修复做成协议重构

本次明确不能：

- 改 `packages/contracts/src/appmsg.ts` 里的 online wire 定义
- 改 `message.online` 的 CBOR 形状
- 给 `HubMsg` 加新的 online 错误返回结构
- 为线上/离线/未知再扩第四种远端状态

理由很简单：现有证据不支持协议已坏，先修用户面前已经确定坏掉的反馈链路。

### 6.2 不能把管理页专用需求扩散到业务层

本次明确不能：

- 改 `AppMsgEndpointService.checkOnline(...)` 对业务侧的返回契约
- 改 `plugin-webrtc` 的前置在线门禁语义
- 给所有调用方强加“必须处理 detailed error”

否则会把管理页的小问题扩散到系统层，收益很低，回归面很大。

### 6.3 不能引入复杂重试、轮询、自动恢复

本次明确不能：

- 点击一次后自动重试多次
- 为 online 查询做指数退避
- 因为 `unknown` 就主动触发 reconnect / sync
- 轮询在线状态直到成功

系统偏好是简单、粗暴、能失败就失败，不把边缘失败做成一套恢复引擎。

### 6.4 不能吞掉“空结果 / unknown”

本次明确不能：

- 只在 `onlineResult` 非空时渲染，其他时候什么都不显示
- 输入非法继续 `return`
- 把 `unknown` 当作“没有结果”

这正是当前用户感知为“卡住/没反应”的核心原因。

---

## 7. 特殊情况先说清楚

### 7.1 输入格式错误

处理原则：

- 不发请求；
- 直接显示本地错误；
- 保持系统其它状态不变。

### 7.2 当前 `appmsg` 未连接或 provider 未 bind

现状下底层很可能回 `unknown`，或者 `inspectLocalDb().state !== "open"`。

处理原则：

- 管理页将其解释为“当前无法确认在线状态”；
- 优先显示“当前消息服务未连接”类提示；
- 可附带 `lastError` 作为辅助信息；
- 不自动触发 reconnect。

### 7.3 底层返回 `unknown`，但没有显式异常

这说明失败已在下层被收敛。

处理原则：

- UI 仍要给出失败类反馈；
- 不把它展示成空白；
- 不强行猜测更深层原因；
- 只利用当前已有快照信息辅助解释。

### 7.4 一次失败后立刻再次查询

处理原则：

- 新查询开始时清掉旧错误；
- 以新一轮请求结果为准；
- 不保留“失败粘住成功”的 UI 残留。

### 7.5 用户查到 `offline`

这不是错误。

处理原则：

- 明确展示为成功结果；
- 不显示失败色、不混入错误文案；
- 避免把 `offline` 和 `unknown` 混为一谈。

---

## 8. 文件级改动清单

### 8.1 `packages/plugin-appmsg/src/AppMsgPage.tsx`

必须修改，职责如下：

- 为在线查询区新增局部状态：
  - 查询输入
  - 查询中态
  - 结果态
  - 错误态 / 反馈文案
- 修复当前输入非法时直接静默 `return` 的行为
- 点击“查询在线”时：
  - 先做本地校验
  - 进入 loading
  - 调 service
  - 按 `online/offline/unknown/error` 更新展示
- 根据 `core.inspectLocalDb()` 的连接态和最近错误补足失败反馈

### 8.2 `packages/plugin-appmsg/src/appmsgService.ts`

必须修改，职责如下：

- 重新定义管理页私有 `checkOnline(...)` 的失败语义
- 避免 service 层继续把所有异常无差别吞掉，导致 UI 没有进入失败分支的机会
- 注释里明确：
  - 这是管理页私有语义
  - 不影响公共 `AppMsgCore` / endpoint service contract

### 8.3 `packages/plugin-appmsg/src/AppMsgPage.test.tsx`

必须修改，新增或调整至少以下测试：

- 非法 `publicKeyHex` 点击查询后显示错误反馈
- 查询中按钮进入禁用态，完成后恢复
- `online` 正常展示
- `offline` 正常展示
- `unknown` 时页面显示明确反馈，不再空白
- 上一轮失败后再次成功，旧错误被清理

测试重点是“用户可见行为”，不是内部 state 细节。

### 8.4 `packages/plugin-appmsg/src/manifest.ts`

按需修改，职责如下：

- 补在线查询区新增文案的中英文 i18n key
- 只补本次需要的最小 key，不顺手整理整页 i18n

### 8.5 `packages/plugin-appmsg/src/styles.css`

按需最小修改，职责如下：

- 为在线查询错误提示、进行中态、结果态补最小样式
- 沿用现有 `appmsg-system-page__*` 命名，不造第二套命名空间

### 8.6 `packages/plugin-hubmsg/src/hubmsgConnection.ts`

原则上**不应**修改协议逻辑。

仅允许在以下前提下做极小修订：

- 发现现有 online 编解码实现与现行 contract/测试明确不一致；
- 且这个不一致可被当前仓库内证据直接证明。

若没有直接证据，本文件不动。

### 8.7 `packages/plugin-hubmsg/src/hubmsgConnection.test.ts`

原则上**不应**修改。

仅当 8.6 出现“被仓库证据直接证明的协议实现错误”时，才同步补测试。

---

## 9. 实施顺序

本次是一次性硬切换，但实现顺序仍固定为：

1. 先改 `AppMsgPage.test.tsx`
   - 先把“非法输入无反馈”“unknown 无反馈”等用户可见问题固化成失败测试
2. 再改 `appmsgService.ts`
   - 让管理页有能力拿到失败
3. 再改 `AppMsgPage.tsx`
   - 接上 loading / error / result 展示
4. 最后补 `manifest.ts` 与 `styles.css`
   - 收口文案和样式

不允许先改一堆样式或顺手改 provider，再回来补测试。

---

## 10. 最终验收清单

### 10.1 交互验收

- [ ] 在 `/system/appmsg` 输入非法公钥后点击“查询在线”，页面立即显示错误提示，不再无反应。
- [ ] 输入合法公钥后点击“查询在线”，按钮出现进行中态，且在请求完成前不可重复点击。
- [ ] 查询结果为 `online` 时，页面明确显示“在线”。
- [ ] 查询结果为 `offline` 时，页面明确显示“离线”。
- [ ] 查询结果为 `unknown` 时，页面明确显示“未知/无法确认/查询失败”类反馈，不再空白。
- [ ] 上一轮查询失败后，下一轮成功会清掉旧错误并展示新结果。

### 10.2 约束验收

- [ ] 未修改 `message.online` 的 wire 协议形状。
- [ ] 未修改 `AppMsgEndpointService.checkOnline(...)` 的公共业务语义。
- [ ] 未引入自动重试、轮询、自动 reconnect、复杂补偿。
- [ ] 未顺手改 `/system/appmsg` 其它无关区块的业务逻辑。

### 10.3 测试验收

- [ ] `packages/plugin-appmsg/src/AppMsgPage.test.tsx` 覆盖非法输入、loading、`online/offline/unknown`、失败后成功恢复等场景。
- [ ] 若 `plugin-hubmsg` 代码未动，则其 online 协议测试保持通过且无需新增兼容测试。
- [ ] 与本次改动直接相关的测试通过。

---

## 11. 一句话收口

这次修的是“管理页在线查询的可见反馈链路”，不是“消息在线协议重做”。

要做的是把静默失败硬切成可见反馈；不能做的是借题发挥改协议、改业务 contract、加复杂恢复机制。
