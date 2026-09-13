# 身份与 Key

Key 是用户在 Vault 中选择和保护的身份。测试需要区分未初始化、已解锁、锁定、刷新恢复、
切换 active Key、删除和恢复；业务成功必须同时看见正确的 publicKeyHex 归属与运行态能力，
不能只看页面标题。

基础初始化 Journey 分为生成 Key（`J-LOCAL-INIT-MENU`）和导入 Hex Key
（`J-LOCAL-INIT-IMPORTED`）；锁定/重新解锁由独立 Flow 复用，多标签恢复由
`J-LOCAL-MULTI-TAB-RECOVERY` 记录。长期资金种子不属于浏览器 Key fixture。
