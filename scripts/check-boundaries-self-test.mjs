// 故意植入实现互导/私有入口，确认正式源码门禁拒绝；只创建独立临时文件。
import { writeFile, unlink } from "node:fs/promises";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
const probes = [
  ["packages/plugin-assets/src", 'import { PluginHostContext as leaked } from "@keymaster/runtime";', "scripts/check-react-resource-boundaries.mjs"],
  ["packages/plugin-assets/src", 'import { WebLoomContext as leaked } from "webloom-framework/react";', "scripts/check-react-resource-boundaries.mjs"],
  ["packages/plugin-assets/src", 'import { PluginConsumerProvider } from "webloom-framework/react";', "scripts/check-react-resource-boundaries.mjs"],
  ["packages/plugin-assets/src", 'import * as host from "@keymaster/runtime/assembly";', "scripts/check-react-resource-boundaries.mjs"],
  ["packages/plugin-assets/src", 'const host = require("@keymaster/runtime/assembly");', "scripts/check-react-resource-boundaries.mjs"],
  ["packages/plugin-assets/src", 'export { PluginHostProvider } from "@keymaster/runtime/assembly";', "scripts/check-react-resource-boundaries.mjs"],
  ["packages/plugin-page/src/settings", 'import { usePluginHost as renamed } from "@keymaster/runtime";', "scripts/check-react-resource-boundaries.mjs"],
  ["packages/plugin-page/src/settings", 'import * as runtime from "@keymaster/runtime";', "scripts/check-react-resource-boundaries.mjs"],
  ["packages/plugin-bsv-price/src", 'const escaped = import("@keymaster/runtime");', "scripts/check-react-resource-boundaries.mjs"],
  ["packages/plugin-page/src/settings", 'import { usePluginHost as renamed } from "../../runtime/src/react/PluginHostProvider.js";', "scripts/check-react-resource-boundaries.mjs"],
  ["apps/web/src", 'import { createPageRegistry } from "../../../packages/plugin-page/src/pageRegistry.js";'],
  ["packages/plugin-assets/src", 'import { rememberIssuedConsumer } from "../../runtime/src/consumerAuthority.js";'],
  ["packages/plugin-assets/src", 'import { STORAGE_PRIVATE_BROWSE_CAPABILITY } from "@keymaster/platform-storage/assembly";'],
  ["packages/plugin-assets/src", 'const forbidden = import("@keymaster/platform-storage/assembly");'],
  ["packages/plugin-assets/src", 'import { forbidden } from "../../platform-storage/src/assembly.js";'],
  ["packages/platform-storage/src", 'import { forbidden } from "@keymaster/plugin-vault";'],
  ["packages/plugin-msfile/src", 'import { forbidden } from "@keymaster/plugin-window-p2p/executor-transport";'],
  ["apps/web/src", 'import { forbidden } from "../../../packages/platform-storage/src/assembly.js";'],
  ["apps/web/src", 'import { StorageBrowseCoordinator } from "@keymaster/platform-storage/assembly";'],
  ["apps/web/src", 'import { createStorageBrowseService } from "@keymaster/platform-storage/coordinator";'],
];
for (const [dir, contents, gate = "scripts/check-boundaries.mjs"] of probes) {
  const file = resolve(dir, `__boundary_probe_${randomUUID()}.ts`);
  try {
    await writeFile(file, contents, { flag: "wx" });
    const result = spawnSync(process.execPath, [gate], { encoding: "utf8" });
    if (result.error) throw result.error;
    if (result.status === 0 || !(result.stdout + result.stderr).includes(file.split("/").at(-1))) {
      throw new Error(`Source boundary did not reject probe ${dir}: ${contents}`);
    }
  } finally { await unlink(file); }
}
console.log(`Source boundary negative checks passed: ${probes.length} real import probes rejected.`);
