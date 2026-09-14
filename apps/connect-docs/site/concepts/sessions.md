# 会话

Connect 区分三个生命周期：

| 层次 | 中文含义 |
| --- | --- |
| Browser transport | Session Window 中的 `postMessage` 连接 |
| Connect session | 绑定 origin、Owner 和可选 App 身份的持久授权 |
| Unlock runtime | 当前窗口短期可用的私钥操作环境 |

`connect.login` 返回 `connectSessionId`（连接会话编号）。窗口关闭只会断开 transport 并清除
短期 runtime，会话授权仍存在；重新打开后用 `connect.resume` 恢复。只有
`connect.logout` 会撤销持久授权。
