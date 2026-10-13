import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
// 统一入口归协议项目所有；Keymaster 命令只转发，不维护第二套场景/刷机逻辑。
const sdk =
  process.env.VLP_SDK_ROOT ??
  fileURLToPath(
    new URL(
      "../../../../BSV8_VaultLinkProtocol/Coding/BSV8_VaultLinkProtocol/",
      import.meta.url,
    ),
  );
const keymaster = fileURLToPath(new URL("../../../", import.meta.url));
const p = spawnSync(
  process.execPath,
  [path.join(sdk, "integration/rockey/run.mjs"), ...process.argv.slice(2)],
  {
    cwd: sdk,
    stdio: "inherit",
    env: { ...process.env, VLP_KEYMASTER_ROOT: keymaster },
  },
);
if (p.error) throw p.error;
process.exit(p.status ?? 1);
