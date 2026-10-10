# Keymaster 产品硬件 E2E 装配

只由 VLP 的独立 E2E 页面编译加载，不挂入正常 App。

- `client.mjs`：调用正常 Window USB bridge，将真实数据通过 MessagePort 传给 Worker。
- `worker.ts`：真实 HardwareConnectionOwner、硬件后端与 HardwareWalletPayments。
- 测试 UI/按键控制留在 VLP/RocKey 的测试外层，不进入正常 Coordinator RPC。

完整设计见 [施工单](../../../docs/proposals/rockey/产品E2E需求与施工单.md)。测试页面不是完整 Keymaster App 页面验收的替代品。

从 Keymaster 根目录可运行 `pnpm test:e2e:rockey:prepare`、`pnpm test:e2e:rockey:list`；确认设备端口后运行 `VLP_SERIAL_PORT=实际端口 pnpm test:e2e:rockey:flash`。命令委托到 VLP 的同一 runner；另支持 `VLP_SDK_ROOT` 指定 SDK 工程。
