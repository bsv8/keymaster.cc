# @keymaster/connect

Keymaster Connect 的浏览器 SDK。一个 Keymaster origin 只有一个初始化时固定网络的钱包；App 不选择私钥或网络，也不会取得私钥。

```ts
import { KeymasterConnectClient } from "@keymaster/connect";
const keymaster = new KeymasterConnectClient({ targetOrigin: keymasterDeploymentOrigin });
const session = await keymaster.login({ text: "登录应用" });
const { publicKeyHex, bsvNetwork } = session.networkIdentity;
// App 根据实际返回的公钥和网络判断是否继续，并向用户提示。
```

首次无需知道公钥或网络。`login`、`resume({ appIdentity? })`、appView 的 `launch` 返回 `networkIdentity`；后续业务参数不再包含 `walletPublicKeyHex`、`networkIdentity` 或用于选择网络的 `assetId`。

SDK 使用接收端签发的临时 transport binding，并持续核对来源、窗口、绑定和身份。绑定不是持久钱包编号或免确认付款凭证，App 不应自行保存、构造或重放。钱包重置、重新初始化或 Worker 重启后旧绑定失效，即使公钥相同也必须显式重新连接。

`connect()` / `ready` 只表示传输可用。`logout()` 撤销当前连接；`close()` 只关闭传输并清空 SDK 本地绑定。SDK 没有默认 Keymaster 地址，必须提供可信精确 origin；appView 使用启动 URL 的 Session Window origin。

产品尚未上线，协议始终在 v1 内演进，不接受旧构造参数、旧业务钱包选择字段及字符串形式的 resume/logout，也不维护旧字段兼容分支。Session Window 产品入口为 `/protocol/v1/popup`，wire 版本同为 1。

支付仍使用钱包的 UTXO manager 和现有审批规则；支付渠道编号、业务幂等编号与付款状态查询不因 API 简化而删除。Connect v1 不开放费用池方法。
