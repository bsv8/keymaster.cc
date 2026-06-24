# 001 Protocol Popup 连接状态感知硬切换一次性迭代施工单

## 参考需求文档

可以参考以下需求文档，施工与验收以这些文档与本单“本单补充定义”段的合集为准：

- `docs/keymaster-protocol-v1-draft.md`
- `docs/keymaster-protocol-common-v1-draft.md`
- `packages/contracts/src/protocol.ts`

需求文档与本单发生冲突时：

1. `docs` 里有明确定义的，以 `docs` 为准。
2. `docs` 当前未覆盖 popup 连接状态语义而本单已明确补钉的，以本单为准。
3. 后续若要改 popup 连接状态语义，必须先改本单与对应 `docs` 段，再改 contract、实现、测试，保持单真值。

## 本单补充定义

> 本段是“当前协议草案没有把 popup 生命周期状态对外语义钉死”这一缺口的
> 一次性补钉。改本段必须先同步改对应 `docs` 段，再改 contract、实现、
> 测试。

- **popup 连接状态只在 popup 窗口级别定义，不在 request 级别定义。**

  也就是说，外部发起方感知的是：

  ```txt
  popup 是否已经 ready
  popup 是否已经结束
  ```

  而不是：

  ```txt
  request 是否正在执行
  request 是否成功
  result 是否已经返回
  ```

- **`ready` 的外部语义**：

  ```txt
  ready = popup 已准备好接收协议 request
        = popup 连接已建立
  ```

  `ready` 只表示 transport ready，不表示用户已授权，不表示存在 active key，
  不表示本次 request 一定会成功。

- **`closing` 的外部语义**：

  ```txt
  closing = popup 会话即将结束或已经进入结束流程
          = popup 连接即将断开
  ```

  `closing` 不承载业务成功失败语义，不携带 `result`，也不替代 `result`。

- **popup 断开最终判定**：

  popup 断开使用下面两条联合判定：

  1. popup 主动发出 `closing`
  2. opener/client 轮询发现 `popup.closed === true`

  其中：

  - `closing` 是主动通知；
  - `popup.closed === true` 是兜底真值；
  - client 侧必须把两者都实现为幂等收敛到 `disconnected`。

- **本次明确不做心跳。**

  不新增：

  ```txt
  ping
  pong
  heartbeat
  keepalive timeout
  ```

  也不因为“若干秒没消息”就判定 popup 已断开。

- **本次明确不引入 MessageChannel。**

  连接状态仍然建立在现有 `window.open + postMessage` 模型上；本次只补
  popup 生命周期状态感知，不改 transport 通道模型。

## 目标

一次性把当前协议补到下面这套最终模型：

```txt
popup 生命周期状态
  = opening
  = connected
  = disconnected

connected 判定
  = 收到 ready

disconnected 判定
  = 收到 closing
  或
  = 轮询发现 popup.closed === true

transport
  = 继续使用 window.open + postMessage
  = 不引入 MessageChannel
  = 不引入心跳

业务结果
  = request/result 继续独立存在
  = 不能拿 result 代替连接关闭
  = 不能拿 closing 代替业务结果
```

本次是硬切换，不接受：

1. 先在 client 侧偷偷做一个“若长时间没消息就当断开”的临时心跳版，后面再统一。
2. 先把 `result` 当作“自然断开”语义，后面再补 `closing`。
3. 先在 popup 页面里写一套关闭通知，contract 和 docs 以后再补。
4. 先做 `MessageChannel` 再说状态，后面再回头处理现有 postMessage 模型。
5. 先让 client 只依赖 `closing`，不做 `popup.closed` 兜底。

## 简述缘由

1. 这次需求关心的不是“私钥会不会被 window 句柄直接读走”，而是“发起 connect 的 client 页面怎样可靠地知道 popup 还活着、什么时候结束”。这是 popup 生命周期问题，不是密码学问题。

2. 当前协议已经有 `ready -> request -> result` 这条业务通道。现在缺的不是另一套 transport，而是对外明确的 popup 生命周期信号。如果为了“能感知断开”引入心跳、MessageChannel、多状态 transport，只会把简单问题做复杂。

3. `popup.closed === true` 是 opener 天然能拿到的浏览器真值；popup 主动发 `closing` 是正常收尾时最快的通知。两者组合已经能覆盖“正常关闭”和“异常来不及通知”两类情况。

4. `result` 和 `closing` 必须分开。业务请求可能失败，但 popup 仍然短时间存在；popup 也可能被用户手工关闭，根本来不及回 `result`。把两者混在一起，client 一定会写出歧义逻辑。

5. 按当前项目一贯原则，这个问题优先选“最小、可验证、异常可收敛”的方案。心跳和 MessageChannel 都不是当前最小解。

## 硬切换结论

### 一、连接状态固定在 popup 窗口级别，不在 request 级别

本次只定义：

```txt
opening
connected
disconnected
```

不要额外对外暴露：

```txt
request-pending
request-executing
request-failed
request-succeeded
```

这些都属于业务层，不属于 popup 连接状态。

### 二、`ready` 继续作为唯一“连接建立”信号

popup 页面启动后，消息监听装好，再向 opener 发 `ready`。

client 侧规则固定为：

```txt
未收到 ready
  = opening

收到 ready
  = connected
```

不要新增：

- `connected`
- `connect-ack`
- `session-open`

这类重复语义消息。

### 三、新增顶层 `closing` 报文作为主动断开通知

popup 在进入结束流程时，主动向 opener 发一条 `closing`。

`closing` 报文只负责说明：

```txt
这个 popup 会话要结束了
```

不负责说明：

- 请求成功还是失败；
- 用户是否授权；
- 有没有 `result`；
- 为什么关闭。

### 四、`popup.closed === true` 是最终兜底断开真值

client/opener 必须保留对 popup 句柄的轮询：

```txt
if (popup.closed === true) => disconnected
```

不要把 `closing` 当成唯一真值。因为下面这些情况都可能导致发不出 `closing`：

- 用户直接点浏览器关闭按钮；
- popup 页面崩溃；
- popup 刷新；
- popup 在 unload 过程中来不及发消息；
- opener/popup 的时序竞争导致消息丢失。

### 五、本次明确不做心跳

不做：

- 周期性 `ping/pong`
- 超时断线判断
- “30 秒没消息就视为断开”

原因很直接：

1. popup 本来就不是长连接服务；
2. 浏览器后台节流会让心跳误判；
3. 当前需求只要知道“窗还在不在”，`closing + popup.closed` 已足够。

### 六、本次明确不做 MessageChannel

这次问题是 popup 生命周期感知，不是 transport 全量改造。

因此本次固定为：

```txt
window.open
+ ready postMessage
+ request postMessage
+ result postMessage
+ closing postMessage
```

不要在这一单里顺手引入：

- `MessageChannel`
- `port.close`
- `connect` 握手
- 双栈 transport 兼容

否则改动面会从“状态补丁”膨胀成“协议 transport 重写”。

## 核心不变量

1. `ready` 仍然只表示 popup 已准备好接收消息，不表示用户授权或业务成功。
2. `closing` 只表示 popup 生命周期结束，不表示业务成功失败。
3. `result` 与 `closing` 必须是两种不同语义的顶层报文。
4. client 侧断开处理必须幂等；收到 `closing` 后再看到 `popup.closed === true` 不能报错。
5. popup 关闭检测必须保留 `popup.closed === true` 轮询兜底。
6. 本次不引入心跳，不基于“若干秒没消息”判定断开。
7. 本次不引入 MessageChannel，不修改现有 window 级双向 postMessage 模型。
8. 不因为新增 `closing` 而改变现有 `request/result` 业务语义。
9. popup 生命周期状态不写入 `localStorage`、`sessionStorage`、`IndexedDB`、URL。
10. 文档、注释、页面说明保持中文；代码里的错误信息保持英文。

## 不能怎么做

1. 不能把 `result` 当成“连接已经断开”的唯一标志。`result` 只是请求结果，不是 popup 生命周期结束信号。

2. 不能把 `closing` 设计成“顺便夹带 result”。这会把连接状态和业务结果再次混成一坨。

3. 不能只依赖 popup 主动发 `closing`，不做 `popup.closed` 轮询兜底。

4. 不能只依赖 `popup.closed` 轮询，不加主动 `closing`。否则正常关闭路径的状态收敛会变慢，也不利于 client 代码明确收尾。

5. 不能引入心跳来解决当前问题：

```txt
setInterval ping
setTimeout timeout
无消息自动断线
```

这会增加状态复杂度，还会被浏览器后台节流干扰。

6. 不能在 popup 内额外创造一套对外 transport 状态机：

```txt
connecting
connected
idle
reconnecting
heartbeat-missed
```

当前需求不需要这些状态。

7. 不能因为“以后可能要 MessageChannel”就先把 contract 设计成双栈可插拔 transport。V1 当前没这个需求。

8. 不能把 popup 生命周期状态落持久化，试图在刷新后“恢复连接”。popup 一旦刷新，就视为旧会话结束。

9. 不能让 client 通过“长时间没收到 result”推断 popup 已经断开。请求卡住、用户还在看确认页、钱包还在等解锁，都会造成误判。

10. 不能把 `closing` 当错误码。`closing` 不是 `error.code`，也不是 `result.ok=false` 的别名。

## 应该怎么做

### 一、先把文档真值补齐，再改 contract 与实现

先在 `docs` 里把下面三件事写死：

1. popup 连接状态只在窗口级别定义；
2. `ready` 是连接建立信号；
3. `closing` 是主动断开通知，`popup.closed` 是兜底真值。

只有文档先钉死，后面的 contract、service、client 示例才不会各写一套语义。

### 二、在 contract 里新增顶层 `closing` 报文类型

`packages/contracts/src/protocol.ts` 需要新增：

- `ProtocolClosingMessage`
- `ProtocolMessage` union 补入 `closing`

建议形状固定为最小对象：

```ts
{
  v: 1,
  type: "closing"
}
```

不要额外加：

- `id`
- `ok`
- `error`
- `reason`
- `method`

这条消息不是业务消息，保持最小即可。

### 三、popup service 负责正常关闭路径上的 `closing`

`packages/plugin-protocol/src/protocolService.ts` 负责在正常结束路径发出 `closing`。

最少覆盖：

1. 成功回完 `result` 后，进入关闭流程前发 `closing`
2. 用户拒绝后，回完失败 `result`，进入关闭流程前发 `closing`
3. service 判定当前会话无法继续并准备结束时，若仍可通知 opener，则发 `closing`

要求：

- `closing` 最多发一次；
- 若发 `closing` 失败，不重试、不缓存，交给 `popup.closed` 兜底；
- 发送失败不阻塞窗口关闭。

### 四、popup 页面负责“用户手工关闭”时的 best-effort `closing`

`packages/plugin-protocol/src/ProtocolPopupPage.tsx` 需要在页面卸载/关闭路径做一次 best-effort 通知。

建议收口原则：

1. 正常业务结束由 service 统一发 `closing`
2. 用户手工关闭窗口、刷新、页面卸载时，页面层再补一次 best-effort `closing`
3. 无论哪条路径触发，最终都要靠“只发一次”保证幂等

这里不要追求“100% 一定发出”。因为 unload 期间浏览器本来就可能来不及完成消息投递。

### 五、client/opener 侧状态机固定为最小三态

client 页面只维护：

```txt
opening
connected
disconnected
```

规则固定为：

1. `window.open(...)` 成功后进入 `opening`
2. 收到 `ready` 后进入 `connected`
3. 收到 `closing` 后进入 `disconnected`
4. 任意时刻轮询发现 `popup.closed === true`，进入 `disconnected`

约束：

- `disconnected` 是终态；
- 重复收到 `closing` 或重复轮询到 `popup.closed === true` 都直接忽略；
- 这套状态机不与 `request/result` 绑定。

### 六、轮询频率固定选择保守值

client 轮询 `popup.closed` 建议固定为：

```txt
500ms 或 1000ms
```

不要为了“更实时”拉到几十毫秒，也不要为了“省一点轮询”拉到太长。

目标不是做游戏帧级同步，而是做 popup 生命周期收敛。

## 特殊情况提前约定

### 情况 A：`window.open(...)` 返回 `null`

处理：

1. 视为 popup 根本没打开。
2. 不进入 `opening`。
3. client 直接报“打开失败”。
4. 不启动 `popup.closed` 轮询。

### 情况 B：popup 打开了，但一直没收到 `ready`

处理：

1. client 保持 `opening`。
2. 若轮询发现 `popup.closed === true`，直接收敛为 `disconnected`。
3. 不能因为“几秒没 ready”就自动判定断开；本次不引入时间超时语义。

### 情况 C：popup 正常返回 `result`，随后发出 `closing`

处理：

1. client 先处理业务 `result`。
2. 再处理连接状态进入 `disconnected`。
3. 两者语义分开，不允许“收到 result 就顺手当成断开”。

### 情况 D：popup 被用户直接手工关闭，没来得及发出 `closing`

处理：

1. client 最终靠 `popup.closed === true` 收敛到 `disconnected`。
2. 不补重试。
3. 不要求 popup 下次启动恢复旧会话。

### 情况 E：popup 发出了 `closing`，但实际窗口还没立刻关掉

处理：

1. client 收到 `closing` 后立即进入 `disconnected`。
2. 不要求等待 `popup.closed === true` 再切状态。
3. 后续轮询到 `popup.closed === true` 只做幂等确认。

### 情况 F：popup 刷新

处理：

1. 旧 popup 会话视为结束。
2. 若旧页来得及发 `closing`，client 按断开处理。
3. 若没来得及发，client 靠 `popup.closed` 或新页面重新 `ready` 后的显式重新发起来收敛。
4. 不恢复旧 request。

### 情况 G：收到重复 `closing`

处理：

1. client 只做第一次状态切换。
2. 重复消息直接忽略。
3. 不记为协议错误。

### 情况 H：opener/client 自己已经不关心这个 popup 了

处理：

1. client 停止轮询即可。
2. popup 侧不需要感知“对方是否还在监听连接状态”。
3. 不增加反向 ack。

### 情况 I：popup 在 error 态停留，用户手工关闭

处理：

1. 若能发 `closing`，则发；
2. 发不出去也不重试；
3. client 最终仍以 `popup.closed === true` 收敛为 `disconnected`。

## 文件级一次性迭代施工单

### 一、`docs`

#### 1. `docs/keymaster-protocol-common-v1-draft.md`

补充公共 transport 定义：

- 顶层报文从 `ready/request/result` 改为 `ready/request/result/closing`
- 明确 `ready` 的连接建立语义
- 明确 `closing` 的主动断开语义
- 明确 popup 生命周期状态感知基于：
  - `ready`
  - `closing`
  - `popup.closed`
- 明确本次不做心跳
- 明确本次不引入 MessageChannel

#### 2. `docs/keymaster-protocol-v1-draft.md`

补一段总览说明：

- popup 生命周期状态是协议公共约定的一部分；
- 连接状态与业务请求结果是两层语义；
- 具体定义收敛在公共约定文档。

### 二、`packages/contracts`

#### 3. `packages/contracts/src/protocol.ts`

新增或调整：

- `ProtocolClosingMessage`
- `ProtocolMessage` union 补入 `closing`
- 相关注释说明：
  - `ready` 是连接建立
  - `closing` 是连接结束
  - `result` 不是连接状态消息

若已有面向 UI 或外部调试的状态类型，也要同步把“连接状态”和“业务 phase”注释区分清楚，避免再次混淆。

### 三、`packages/plugin-protocol`

#### 4. `packages/plugin-protocol/src/protocolService.ts`

新增连接关闭通知能力，要求：

- 内部维护“本会话是否已发送 closing”的幂等标记
- 正常完成路径发 `closing`
- 失败结束路径发 `closing`
- 发不出去直接忽略，不重试

同时保证：

- 现有 `request/result` 语义不被破坏
- `closing` 不与 `result` 合并
- `endSession()` 清理状态时不产生重复关闭风暴

#### 5. `packages/plugin-protocol/src/ProtocolPopupPage.tsx`

补页面关闭路径上的 best-effort `closing` 触发，要求：

- 用户直接关闭、刷新、卸载时尽量通知 opener
- 与 service 层发送共用同一幂等门禁
- 不在页面层复制一套协议状态机

#### 6. `packages/plugin-protocol/src/protocolService.test.ts`

新增覆盖：

- `startSession()` 后仍先发 `ready`
- 正常成功路径：`result` 后会发送一次 `closing`
- 用户拒绝路径：失败 `result` 后会发送一次 `closing`
- 重复结束路径不会重复发送 `closing`
- `closing` 发送失败不会阻塞 session 收尾

#### 7. `packages/plugin-protocol/src/ProtocolPopupPage.test.tsx`

新增覆盖：

- 页面卸载/关闭路径会触发 best-effort `closing`
- service 已发过 `closing` 时，页面层不会重复发送

### 四、示例/接入说明

#### 8. 第三方接入示例或相关文档

如果仓库里已有 demo 或接入说明，必须同步补上 client 侧最小状态机：

- `opening`
- `connected`
- `disconnected`

并明确：

- 收到 `ready` 才算连上
- 收到 `closing` 或发现 `popup.closed === true` 算断开
- 不做心跳

如果仓库当前没有接入示例文件，本项可以只在 `docs` 与本施工单中落定义，不额外造新 demo。

## 最终验收清单

### 一、文档验收

1. 公共协议文档已经明确定义 `closing` 顶层报文。
2. 文档已经明确定义 popup 生命周期状态感知是窗口级别，而不是 request 级别。
3. 文档已经明确 `ready` / `closing` / `popup.closed` 三者分工。
4. 文档已经明确本次不做心跳、不引入 MessageChannel。

### 二、contract 验收

1. `packages/contracts/src/protocol.ts` 已存在 `ProtocolClosingMessage`。
2. `ProtocolMessage` union 已包含 `closing`。
3. 合同注释没有把 `result` 与连接断开语义混在一起。

### 三、popup 实现验收

1. popup 启动后仍只在监听安装完成后发送 `ready`。
2. popup 正常结束路径会发送一次且仅一次 `closing`。
3. popup 失败结束路径也会发送一次且仅一次 `closing`。
4. popup 关闭通知发送失败不会阻塞窗口关闭或 session 结束。
5. 页面卸载/手工关闭路径存在 best-effort `closing`，但不会形成重复风暴。

### 四、client 接入语义验收

1. client 可以只靠 `ready` 判定 `connected`。
2. client 可以只靠 `closing` 或 `popup.closed === true` 判定 `disconnected`。
3. client 不需要实现心跳。
4. client 不会把 `result` 当成断开真值。
5. client 对重复 `closing` 或重复 `popup.closed === true` 判定是幂等的。

### 五、特殊情况验收

1. popup 手工关闭但没来得及发 `closing` 时，client 最终仍能通过 `popup.closed === true` 收敛到 `disconnected`。
2. popup 正常回完 `result` 后，client 不会因为等待 `popup.closed === true` 才处理断开。
3. popup 刷新不会恢复旧会话。
4. `window.open(...)` 返回 `null` 时不会误进入“连接中”。

### 六、自动化验收

执行并通过：

1. `npm run typecheck`
2. `npm run test`
3. `npm run lint:boundaries`

### 七、人工验收

至少手工验证下面几条：

1. 外部页面打开 popup 后，能稳定收到 `ready`，client 状态进入 `connected`。
2. popup 完成一次成功请求后，client 先收到 `result`，随后收到 `closing` 或很快轮询到关闭，状态进入 `disconnected`。
3. popup 在确认页被用户手工关闭时，即使没收到 `closing`，client 仍能通过 `popup.closed === true` 进入 `disconnected`。
4. popup 在失败态关闭时，client 连接状态仍能正常收敛，不需要心跳。

## 施工结束判定

只有当下面三件事同时成立，本单才算完成：

1. popup 连接状态已经被定义成一套单一、最小、可验证的公共语义：`ready` 建连，`closing`/`popup.closed` 断开。
2. 实现没有引入心跳、MessageChannel、双栈 transport 或 request 级连接状态膨胀。
3. client 接入方不需要猜“什么时候算连上、什么时候算断开、`result` 和 `closing` 到底谁代表什么”。
