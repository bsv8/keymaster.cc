# 安全模型

- 来源：消息必须同时来自配置的精确 origin 和当前 Session Window。
- Owner：业务方法只使用 Connect 会话绑定的 Owner，不回退到钱包当前 Key。
- App 身份：Storage 和 MSFile 需要已验证的发行人签名；普通会话不能靠追加参数升级身份。
- 用户确认：支付文案和授权策略由 Keymaster 控制，App 不能把支付伪装成普通操作。
- 私钥：SDK 只得到公开身份、签名、密文、消息和结果，永远得不到私钥或可复用共享密钥。
