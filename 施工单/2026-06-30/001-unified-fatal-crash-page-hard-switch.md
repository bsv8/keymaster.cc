# 001 统一崩溃性错误兜底页硬切换施工单

## 目标

一次性把前端运行时切换到下面这套最终模型：

```txt
运行期出现“系统已不可信”的 fatal 错误
  -> 立即退出当前正常应用渲染路径
  -> 统一落到同一个崩溃性错误兜底页

崩溃页
  -> 不依赖 React 业务树
  -> 不依赖 plugin host / i18n / Vault 状态
  -> 只负责说明“系统启动/运行失败”与展示诊断信息

普通业务错误
  -> 不升级成全局 fatal
  -> 继续走页面内现有错误提示或局部边界

本次不做
  -> 导出 key
  -> 清理数据
  -> 维护工具
  -> 恢复模式
```

本次是硬切换，不接受“先加一个 ErrorBoundary 顶着”“先只抓 React render，后面再补异步与持久化错误”“先继续把坏数据伪装成 uninitialized”这类中间态。

## 简述缘由

1. 这次现象已经证明：系统可能因为浏览器本地旧数据、升级后的持久化结构不兼容、或某段运行时状态损坏而失效，但当前没有统一、可信的 fatal 落点。
2. 仅靠浏览器 console 不可靠。现实里既可能“有报错但用户没看到”，也可能“代码把错误吞掉，页面只是表现为空白或异常状态”。
3. 当前 [apps/web/src/main.tsx](/home/david/Workspaces/keymaster.cc/apps/web/src/main.tsx:1) 只兜住 React 挂载前的启动异常；React 挂载后的 render / effect / promise / 持久化数据异常没有统一收口。
4. 当前 [packages/plugin-vault/src/vaultService.ts](/home/david/Workspaces/keymaster.cc/packages/plugin-vault/src/vaultService.ts:1) 的 `bootstrap()` 在某些错误下会直接降级成 `uninitialized`，这会把“本地数据坏了”伪装成“像第一次启动”，误导用户，也让排障失真。
5. 既然本次明确不做维护工具，那最合理的最小闭环就是：

```txt
先把 fatal 错误截获清楚
再把 fatal 错误稳定显示出来
而不是继续让系统沉默失败
```

## 问题定义

当前缺口分成四类：

### 一、启动前异常只能抓一部分

[apps/web/src/main.tsx](/home/david/Workspaces/keymaster.cc/apps/web/src/main.tsx:1) 的 `start()` 外层 `try/catch` 能抓：

```txt
checkEnvironment()
bootstrapPlugins()
首次 createRoot / render 调用
```

但抓不到：

```txt
React 树挂载后的 render 崩溃
effect 内未处理异常
未处理 Promise rejection
某个 service 自己 catch 后错误降级
```

### 二、React 树没有顶级 fatal 边界

仓库里只有局部边界，例如 [packages/plugin-transfer/src/TransferPage.tsx](/home/david/Workspaces/keymaster.cc/packages/plugin-transfer/src/TransferPage.tsx:177) 的 `ProviderErrorBoundary`。这类局部边界不等于系统级兜底。

当前没有一个“整棵应用树已不可信时”的统一出口。

### 三、全局浏览器错误没有系统接管

仓库里目前没有：

```txt
window error handler
window unhandledrejection handler
统一 fatal store
```

这意味着：

1. 启动后异步崩溃可能只留在 console。
2. 某些错误即使是系统级，也不会把 UI 切到一个稳定诊断页。

### 四、持久化数据损坏没有统一升级为 fatal

最关键的是这一条。

像下面这些场景，本质都不是“普通业务失败”，而是“当前本地运行时已不可信”：

```txt
Vault meta 能读到，但 vault_keys 结构不符合当前代码假设
解密后的私钥材料 JSON.parse 失败
IndexedDB schema / version 与代码预期冲突，且当前路径无法安全自愈
启动阶段读取关键持久化状态时发生不可恢复异常
```

这类错误如果继续假装成：

```txt
uninitialized
locked
空页面
普通业务报错
```

都会把系统带到错误状态。

## 硬切换结论

本次统一采用下面这套最终规则：

```txt
fatal 错误
  = 当前运行时可信性已经丢失
  = 继续正常渲染会误导用户或放大损坏

fatal 一旦确认
  = 第一时间写入统一 fatal store
  = 退出正常 React 应用路径
  = 渲染纯 DOM 崩溃页

普通业务错误 / 输入错误 / 网络错误
  != fatal
  不允许滥用全局崩溃页
```

同时明确三条边界：

1. **不新增 `VaultStatus = "fatal"`**。  
   理由：这是全局应用级退出语义，不应把 `fatal` 扩散到整个 Vault 状态机、App 分支、业务页面条件判断里。

2. **崩溃页不依赖 React 业务树**。  
   理由：既然要兜底，就不能再依赖已经可能坏掉的 host、hook、route、theme、i18n。

3. **不是所有错误都升级为 fatal**。  
   理由：系统要的是“关键错误必接管”，不是“任何异常都把用户踢出应用”。

## fatal 与非 fatal 的硬规则

### 必须升级为 fatal 的错误

下面这些场景一律进入统一崩溃页：

1. `bootstrapPlugins()` 失败。
2. 顶级 React 树 render / lifecycle 未被局部边界吸收并一路冒泡到顶层。
3. 已确认来自本应用 bundle 的 `window.error`。
4. 已确认来自本应用关键启动链的 `unhandledrejection`。
5. Vault / keyspace / runtime 在**启动或关键状态恢复阶段**发现持久化数据损坏、schema 不满足、关键记录形状错误，且继续运行会失真。
6. 任何“当前状态被伪装成正常会误导用户”的系统级 invariant 破坏。

### 不能升级为 fatal 的错误

下面这些错误不能把整站切到崩溃页：

1. 主题、语言、插件开关这类 `localStorage` 最佳努力读写失败。
2. WOC 请求失败、链上接口限流、普通网络错误。
3. 导入私钥内容格式错误、密码输错、标签校验失败。
4. 某个业务页可局部处理的 provider 错误。
5. 第三方脚本、浏览器扩展、分析脚本抛出的非本应用错误。

这条边界必须写进代码注释，不能靠默契。

## 不能怎么做

1. 不能只在 [apps/web/src/main.tsx](/home/david/Workspaces/keymaster.cc/apps/web/src/main.tsx:1) 外层再多包几层 `try/catch`，因为这抓不到挂载后的 React 异常与异步异常。
2. 不能只加 React `ErrorBoundary` 就算完成。`ErrorBoundary` 抓不到：
   - `window` 级错误
   - `unhandledrejection`
   - 已被 service 吞掉并错误降级的持久化异常
3. 不能把崩溃页做成普通 React 页面、挂在 route 里，例如 `/fatal`。  
   这会让兜底页依赖 route / host / i18n / shell，自身不稳。
4. 不能继续让 Vault 启动时的关键持久化异常静默降级成 `uninitialized`。这会把数据损坏伪装成正常首启。
5. 不能把所有 `window.error` / `unhandledrejection` 都无脑升级成 fatal。浏览器扩展、Cloudflare analytics、第三方噪音会误伤。
6. 不能为了“页面别白”而在崩溃后继续保留部分旧 UI。fatal 的语义就是“当前正常应用路径已退出”。
7. 不能在本次顺手加入“导出 key / 清空数据 / 一键修复”按钮。当前要求是统一崩溃兜底，不是维护台。
8. 不能把 `fatal` 状态塞进 `VaultStatus`、`RuntimeStatus`、各种页面分支里到处判断。全局退出语义应收敛到一条 store 与一个纯 DOM 页面。
9. 不能让 shell 或业务插件直接 import `apps/web` 私有模块。fatal 基础设施如果要跨包复用，必须落在共享层。

## 应该怎么做

### 总体策略

建立一条**全局 fatal 通道**：

```txt
reportFatalError(input)
  -> 归一化错误对象
  -> 写入全局 fatal store
  -> 通知唯一订阅者接管页面

页面接管
  -> 若 React 尚未挂载：直接渲染崩溃页
  -> 若 React 已挂载：卸载 root，再渲染崩溃页
```

这里的关键不是“多抓一点错误”，而是把 fatal 的**定义、上报、展示、接管**四件事都收拢到同一套机制里。

### 一、增加共享 fatal store

建议在 `packages/runtime` 新增一个纯逻辑模块，例如：

```txt
packages/runtime/src/fatalErrorStore.ts
```

职责：

1. 定义 `FatalErrorSnapshot`：

```txt
id
time
phase
scope
message
stack
source
cause
```

2. 导出：

```txt
reportFatalError(input)
getFatalError()
subscribeFatalError(listener)
resetFatalErrorForTest()
```

3. 语义：
   - 第一条 fatal 错误生效并接管页面；
   - 后续 fatal 只记录到内存附注或直接忽略，不反复重绘；
   - store 本身不依赖 DOM / React / browser。

设计缘由：

1. `apps/web` 和 `plugin-vault` 都能用。
2. 不把 fatal 上报路径耦合进 messageBus；fatal 可能发生在 host 还没创建之前。
3. 不把 fatal 基础设施塞进 `apps/web` 私有目录，避免共享包无法安全引用。

### 二、增加统一崩溃页渲染器

建议把现有 [apps/web/src/bootstrapError.ts](/home/david/Workspaces/keymaster.cc/apps/web/src/bootstrapError.ts:1) 升级为真正的 fatal 页面渲染器，或新建：

```txt
apps/web/src/fatalCrashPage.ts
```

要求：

1. 纯 DOM 渲染，不依赖 React。
2. idempotent：重复调用不会越渲越乱。
3. 页面内容固定、简单、中文为主：

```txt
标题：KeyMaster 启动/运行失败
说明：当前浏览器本地运行时发生不可恢复错误
详情：错误摘要、阶段、时间、技术详情
动作：仅提供“刷新页面”
```

4. 不提供：

```txt
导出 key
全清理数据
恢复模式
跳转业务页
```

5. 如果 fatal 页自身渲染再失败，最后兜底回退到 `<pre>` 文本输出。

### 三、在 main.tsx 安装统一接管流程

在 [apps/web/src/main.tsx](/home/david/Workspaces/keymaster.cc/apps/web/src/main.tsx:1) 做硬切换：

1. 启动最前面安装 fatal store 订阅。
2. 统一通过 `reportFatalError(...)` 进入 fatal 通道，而不是直接 `renderFatalError(message)`。
3. 记录 `root` 引用；fatal 到来后：
   - 已创建 root：`root.unmount()`
   - 无 root：直接渲染纯 DOM fatal 页
4. 现有 `checkEnvironment()` 的“环境不满足”仍可直接显示当前错误页，但要统一走 fatal 页面渲染器，而不是保留两套页面样式。

### 四、增加顶级 React fatal 边界

建议新增：

```txt
apps/web/src/AppCrashBoundary.tsx
```

职责：

1. 作为整棵业务树的唯一顶层 `ErrorBoundary`。
2. `componentDidCatch` 内统一：

```txt
reportFatalError({
  phase: "react.render",
  scope: "app-root",
  ...
})
```

3. `fallback` 不渲染业务 UI，不渲染“继续使用”按钮；最多返回 `null`，因为真正展示由纯 DOM fatal 页接管。

不能怎么做：

1. 不能在这个 boundary 里再渲染一套复杂 React 错误页。
2. 不能把它当局部页面错误边界用。它是系统级退出边界。

### 五、安装 window 级错误处理，但必须做来源过滤

在 `apps/web` 侧新增全局安装逻辑，例如：

```txt
apps/web/src/installGlobalFatalHandlers.ts
```

规则要写死：

1. `window.error`
   - 仅当 `filename` 指向本应用同源 bundle、或 error stack 明确来自本应用代码时，才升级成 fatal。
   - 扩展脚本、第三方脚本、analytics 脚本错误只 `console.warn`，不接管页面。

2. `window.unhandledrejection`
   - 仅当 `reason` 可归因为本应用关键启动链或本应用 bundle 时升级为 fatal。
   - 无法判断来源的 opaque rejection，不默认升级。

设计缘由：

```txt
宁可漏接第三方噪音
也不能让浏览器扩展把整个站点误打进崩溃页
```

### 六、把关键“静默降级”改成显式 fatal

这是本次真正能截住“坏数据无报错崩溃”的关键。

重点修改 [packages/plugin-vault/src/vaultService.ts](/home/david/Workspaces/keymaster.cc/packages/plugin-vault/src/vaultService.ts:1)：

1. `bootstrap()` 里：
   - `meta` 不存在 -> 正常 `uninitialized`
   - `meta` 存在但读取/解析/关键流程失败 -> `reportFatalError(...)`

2. 不能再把“关键持久化异常”直接收敛成：

```txt
console.error(...)
setStatus("uninitialized")
```

3. 必须把“什么算关键持久化异常”写清楚，例如：
   - 打开 Vault DB 失败
   - 读取 meta 失败
   - 读取 keys 失败
   - 关键记录结构不满足当前代码前提

注意：

1. 这里**不**要求把每一条旧数据问题都做成数据迁移器。
2. 本次只要求“发现不可恢复异常时别伪装正常”。

### 七、保留局部错误边界，但系统级错误最终仍能升级

像 [packages/plugin-transfer/src/TransferPage.tsx](/home/david/Workspaces/keymaster.cc/packages/plugin-transfer/src/TransferPage.tsx:177) 这种局部 `ProviderErrorBoundary` 可以保留。

规则是：

1. 局部边界能自己消费的业务错误，继续局部展示。
2. 未被局部边界吸收、一路冒泡到顶层的异常，交给全局 fatal 通道。

这样可以避免两种极端：

```txt
所有错误都全局崩
所有错误都局部吞
```

## 特殊情况与处理规则

### 情况一：fatal 发生在 React 挂载之前

处理原则：

```txt
不等 React
直接纯 DOM 接管
```

应该这样做：

1. `main.tsx` 启动最前面就订阅 fatal store。
2. `bootstrapPlugins()`、环境检查、启动链上的 fatal 直接进入崩溃页。

### 情况二：fatal 发生在 React 已挂载之后

处理原则：

```txt
先退出旧树
再接管页面
```

应该这样做：

1. 若 `root` 已创建，先 `root.unmount()`。
2. 再渲染纯 DOM fatal 页。

不能这样做：

1. 不能一边保留旧树一边再 append 一个错误容器。
2. 不能试图“只遮住一部分 UI”。

### 情况三：浏览器扩展或第三方脚本抛错

处理原则：

```txt
默认不接管页面
```

应该这样做：

1. 通过 `filename`、stack、同源路径判断是否来自本应用 bundle。
2. 非本应用来源只记 console，不升级 fatal。

原因：

```txt
否则用户装了一个坏扩展，就会让 KeyMaster 永远显示系统崩溃页
```

### 情况四：主题/语言/localStorage 偏好读取失败

处理原则：

```txt
保持当前“最佳努力降级”
不升 fatal
```

原因：

1. 这类数据不是安全关键、不影响 Vault 真值。
2. 把它们升成 fatal 会严重放大问题面。

### 情况五：Vault 关键持久化读取失败

处理原则：

```txt
升 fatal
不伪装成首启
```

应该这样做：

1. 如果 `vault_meta` 不存在，这是正常首启。
2. 如果 `vault_meta` 存在，但后续关键读取失败，这说明“本地有系统数据，但当前代码不能可信使用它”。
3. 此时进入统一崩溃页，而不是落到 `LockedShell` 欢迎页。

### 情况六：崩溃页自身渲染失败

处理原则：

```txt
退回最原始文本输出
```

应该这样做：

1. final fallback 是一个 `<pre>`。
2. 不能让“兜底页失败”再次进入 React 或 fatal store 递归。

### 情况七：同一次会话里连续触发多条 fatal

处理原则：

```txt
首条 fatal 赢
后续不重复接管
```

应该这样做：

1. fatal store 只允许从 `null -> snapshot` 进入一次。
2. 后续 fatal 最多追加到内存辅助字段或直接忽略。

原因：

```txt
系统已经退出正常路径
再重复接管没有意义
```

## 文件级施工

### 一、packages/runtime/src/fatalErrorStore.ts

新增共享 fatal store。

职责：

1. 定义 fatal snapshot 类型与归一化逻辑。
2. 提供 `report / read / subscribe / resetForTest`。
3. 不依赖 DOM、window、React。

注释要明确：

```txt
这是全局应用级退出通道，不是普通日志通道。
fatal 一旦确认，当前正常 UI 路径不再可信。
```

### 二、packages/runtime/src/index.ts

导出 fatal store 的公共 API，供 `apps/web` 与 `plugin-vault` 统一引用。

原则：

1. 只导出必要符号。
2. 不把测试 helper 暴露给生产调用方，除非仓库现有导出风格要求。

### 三、apps/web/src/fatalCrashPage.ts

新增或替换为统一崩溃页 DOM 渲染器。

要求：

1. 纯 DOM。
2. 中文文案。
3. 无维护工具按钮。
4. 仅展示 fatal 摘要与刷新动作。

### 四、apps/web/src/installGlobalFatalHandlers.ts

新增全局 browser handler 安装逻辑。

要求：

1. `error` / `unhandledrejection` 分开处理。
2. 明确做 same-origin / app-bundle 来源过滤。
3. 过滤规则写注释，不允许“魔法 if”。

### 五、apps/web/src/AppCrashBoundary.tsx

新增顶级 React fatal boundary。

要求：

1. `componentDidCatch` 上报 fatal。
2. 不渲染复杂 fallback UI。
3. 作为唯一顶层系统级 boundary 使用。

### 六、apps/web/src/main.tsx

硬切换为统一 fatal 驱动入口。

需要完成：

1. 安装 global handlers。
2. 订阅 fatal store。
3. 维护 root 引用。
4. 将现有 `renderFatalError(...)` 入口统一改为 `reportFatalError(...)` 或统一 fatal 渲染器。
5. React 根节点外层包 `AppCrashBoundary`。

### 七、apps/web/src/bootstrapError.ts

二选一：

1. 删除旧实现并改用新 `fatalCrashPage.ts`
2. 保留文件名，但语义升级成统一 fatal 页面渲染器

要求：

1. 最终仓库里只能保留**一套**系统级 fatal 页实现。
2. 不能并存“bootstrap 错误页”和“运行时崩溃页”两套分裂样式。

### 八、packages/plugin-vault/src/vaultService.ts

把关键持久化异常从“静默降级”改成“显式 fatal”。

重点是：

1. `bootstrap()` 关键路径。
2. 任何“继续伪装为正常首启/正常 locked 会误导用户”的异常点。

不要求：

1. 这一版就做数据迁移。
2. 这一版就做修复工具。

### 九、tests

至少覆盖下面几类：

1. fatal store：
   - 首次 report 生效
   - 重复 report 不反复覆盖
   - subscribe 正常通知

2. 顶级 boundary：
   - 子组件 render 抛错 -> reportFatalError 被调用

3. global handler：
   - 同源应用错误 -> 升 fatal
   - 第三方脚本错误 -> 不升 fatal

4. vault bootstrap：
   - `meta` 不存在 -> 正常 uninitialized
   - 关键持久化读取失败 -> reportFatalError，而不是伪装 uninitialized

## 最终结构

本次落地后，fatal 主链应收敛成：

```txt
packages/runtime/src/
  fatalErrorStore.ts

apps/web/src/
  AppCrashBoundary.tsx
  fatalCrashPage.ts
  installGlobalFatalHandlers.ts
  main.tsx

packages/plugin-vault/src/
  vaultService.ts
```

系统语义应变成：

```txt
启动前 fatal
  -> main.tsx -> fatal store -> 纯 DOM 崩溃页

React 顶层崩溃
  -> AppCrashBoundary -> fatal store -> 卸载 root -> 纯 DOM 崩溃页

浏览器全局应用级异常
  -> global handlers -> fatal store -> 纯 DOM 崩溃页

关键持久化损坏
  -> service 显式 reportFatalError -> 纯 DOM 崩溃页
```

## 最终验收清单

### 代码级验收

1. 仓库里存在唯一的共享 fatal store，且位于共享层，不在 `apps/web` 私有目录里自说自话。
2. `apps/web` 存在唯一的系统级 fatal 页 DOM 渲染器。
3. `main.tsx` 已统一通过 fatal store 接管，而不是散落多套 `renderFatalError(...)`。
4. 顶级 React 树外层已接入 `AppCrashBoundary`。
5. 已安装 `window.error` 与 `window.unhandledrejection`，并包含来源过滤。
6. `vaultService.bootstrap()` 不再把关键持久化异常伪装成 `uninitialized`。
7. 没有新增导出 key / 清理数据 / 修复模式按钮。
8. 没有把 `fatal` 状态扩散进 `VaultStatus` 或各业务页面状态机。

### 测试级验收

1. `typecheck` 通过。
2. `build` 通过。
3. 新增测试覆盖：
   - fatal store
   - AppCrashBoundary
   - global handler 来源过滤
   - vault bootstrap fatal 上报

### 行为级验收

1. 人工制造 `bootstrapPlugins()` 抛错时，页面直接进入统一崩溃页。
2. 人工制造顶级 React render 抛错时，页面退出旧树并进入统一崩溃页。
3. 人工制造浏览器扩展/第三方脚本错误时，不误进崩溃页。
4. 人工制造 Vault 启动阶段关键持久化读取失败时：
   - 不落欢迎页
   - 不伪装成 `uninitialized`
   - 直接进入统一崩溃页
5. 正常的主题、语言、网络、导入格式错误不误进崩溃页。

### 反验收

出现下面任一情况，都算本次未完成：

1. 系统仍然可能因为关键持久化损坏而表现为空白、假首启、假 locked、无统一崩溃页。
2. 崩溃页仍依赖 React 业务树或 host 才能显示。
3. 第三方脚本错误能把整站误打进崩溃页。
4. 代码里同时并存两套系统级 fatal 页面实现。
5. 本次偷偷把维护工具、清理数据按钮一起塞进来了。
