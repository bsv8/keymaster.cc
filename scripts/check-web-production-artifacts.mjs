import { promises as fs } from "node:fs";
import { join, relative, resolve } from "node:path";

const distDirectory = resolve("apps/web/dist");
const forbiddenMarkers = [
  "__msfileExecutorSpike",
  "msfile-spike-test-password",
  "msfileSpike",
];

async function listFiles(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await listFiles(path));
    else files.push(path);
  }
  return files;
}

try {
  const files = (await listFiles(distDirectory)).filter((path) => /\.(?:html|js|mjs|css)$/u.test(path));
  const matches = [];
  for (const path of files) {
    const content = await fs.readFile(path, "utf8");
    for (const marker of forbiddenMarkers) {
      if (content.includes(marker)) matches.push(`${relative(process.cwd(), path)} contains ${marker}`);
    }
  }
  if (matches.length > 0) {
    console.error("普通生产包包含 MSFile spike 测试控制器标识：");
    for (const match of matches) console.error(`- ${match}`);
    process.exitCode = 1;
  } else {
    console.log(`生产产物扫描通过：${files.length} 个 HTML/JS/CSS 文件未包含 MSFile spike 控制器。`);
  }
} catch (error) {
  console.error(`无法扫描 ${distDirectory}：${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
