#!/usr/bin/env node

/**
 * 集成测试覆盖矩阵门禁。
 *
 * `覆盖矩阵.yaml` 使用 JSON 子集，所以这里不引入一个可能在 CI 缺失的
 * YAML 解析器。脚本只负责静态一致性：它不会把“文件存在”当成测试通过，
 * 真实资源和部署层级仍由各自的 Playwright 命令产生证据。
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const root = process.cwd();
const matrixPath = path.join(root, "docs/集成测试/覆盖矩阵.yaml");
const markdownPath = path.join(root, "docs/集成测试/覆盖矩阵.md");
const catalogPath = path.join(root, "apps/web/src/pluginCatalog.ts");
const integrationRoot = path.join(root, "e2e/integration");

const REQUIRED_FIELDS = [
  "requirement_id", "business_domain", "user_role", "user_goal", "starting_state",
  "expected_result", "technical_truths", "failure_paths", "resource_profile",
  "cleanup_policy", "gate_level", "scenario_ids", "evidence", "status"
];
const STATUS = new Set(["已覆盖", "部分覆盖", "未覆盖", "阻断"]);
const LEVELS = new Set(["local-integration", "real-resource", "deployment-acceptance"]);

function fail(message) {
  throw new Error(`[integration-coverage] ${message}`);
}

function read(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch (error) {
    fail(`无法读取 ${path.relative(root, file)}：${error instanceof Error ? error.message : "unknown error"}`);
  }
}

function unique(values) {
  return [...new Set(values)];
}

function sorted(values) {
  return [...values].sort((a, b) => a.localeCompare(b));
}

function parseMatrix() {
  let value;
  try {
    value = JSON.parse(read(matrixPath));
  } catch (error) {
    fail(`覆盖矩阵.yaml 必须是有效的 JSON 子集：${error instanceof Error ? error.message : "parse error"}`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("矩阵根节点必须是对象");
  if (value.schema_version !== 1) fail("当前只支持 schema_version=1");
  if (!Array.isArray(value.catalog_plugins)) fail("catalog_plugins 必须是数组");
  if (!Array.isArray(value.formal_protocols)) fail("formal_protocols 必须是数组");
  if (!Array.isArray(value.requirements)) fail("requirements 必须是数组");
  return value;
}

function catalogPackages() {
  const source = read(catalogPath);
  const imports = new Map();
  for (const match of source.matchAll(/import\s*\{\s*([A-Za-z0-9_]+)\s*\}\s*from\s*["'](@keymaster\/[^"']+)["']/g)) {
    imports.set(match[1], match[2]);
  }
  const sourceMatch = source.match(/const\s+WEB_PLUGIN_CATALOG_SOURCE[\s\S]*?=\s*\[[\s\S]*?\n\];/);
  if (!sourceMatch) fail("无法定位 WEB_PLUGIN_CATALOG_SOURCE");
  const selected = [];
  for (const [alias, packageName] of imports) {
    if (new RegExp(`\\b${alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(sourceMatch[0])) {
      selected.push({ alias, packageName });
    }
  }
  if (selected.length === 0) fail("没有从 pluginCatalog.ts 读取到正式插件");
  return selected;
}

function packageSourceDirectory(packageName) {
  return path.join(root, packageName === "@keymaster/platform-storage"
    ? "packages/platform-storage/src"
    : `packages/${packageName.replace("@keymaster/", "")}/src`);
}

function sourceFiles(directory) {
  const files = [];
  function visit(current) {
    if (!fs.existsSync(current)) return;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) visit(target);
      else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) files.push(target);
    }
  }
  visit(directory);
  return files;
}

/** E2E 浏览器层必须走真实网络/存储，不允许注入响应或假 provider。 */
function validateE2EBrowserBoundary() {
  const forbidden = [
    { pattern: /\b(?:page|context)\.route\s*\(/u, label: "Playwright route 拦截" },
    { pattern: /\broute\.(?:fulfill|abort|continue)\s*\(/u, label: "网络响应替换/阻断" },
    { pattern: /\b(?:Fake[A-Za-z0-9_]*|fake[A-Za-z0-9_]+)\b/u, label: "fake provider/适配器命名" },
  ];
  for (const file of sourceFiles(path.join(root, "e2e"))) {
    const text = read(file);
    for (const item of forbidden) {
      if (item.pattern.test(text)) fail(`${path.relative(root, file)} 包含禁止的 E2E ${item.label}；真实资源/网络证据不能由测试替身产生`);
    }
  }
}

function staticStringConstants(packageName) {
  const constants = new Map();
  for (const file of [...sourceFiles(packageSourceDirectory(packageName)), ...sourceFiles(path.join(root, "packages/contracts/src"))]) {
    const text = read(file);
    for (const match of text.matchAll(/(?:export\s+)?const\s+([A-Z][A-Z0-9_]*)\s*=\s*["']([^"']+)["']/g)) constants.set(match[1], match[2]);
  }
  return constants;
}

function resolveStaticString(expression, constants) {
  const value = expression.trim().replace(/[,;]+$/u, "");
  const literal = value.match(/^["']([^"']+)["']$/u);
  if (literal) return literal[1];
  return constants.get(value);
}

function packageManifest(packageName) {
  const packageDir = packageName === "@keymaster/platform-storage"
    ? "packages/platform-storage"
    : `packages/${packageName.replace("@keymaster/", "")}`;
  const file = path.join(root, packageDir, "src/manifest.ts");
  if (!fs.existsSync(file)) fail(`${packageName} 没有找到 src/manifest.ts`);
  return { file, text: read(file) };
}

function staticManifestPluginId(packageName) {
  const { text } = packageManifest(packageName);
  const match = text.match(/const\s+[A-Za-z0-9_]+PluginDefinition\s*=\s*\{\s*id:\s*([^,\n]+)/u);
  if (!match) fail(`${packageName} 的 manifest 没有可静态检查的 PluginDefinition id`);
  const value = resolveStaticString(match[1], staticStringConstants(packageName));
  if (!value) fail(`${packageName} 的 manifest plugin id 不是静态字符串`);
  return value;
}

function staticManifestRoutes(packageName) {
  const { text } = packageManifest(packageName);
  const constants = staticStringConstants(packageName);
  return unique([...text.matchAll(/\bpath:\s*(?:["']([^"']+)["']|([A-Z][A-Z0-9_]*))/g)]
    .map((match) => match[1] ?? constants.get(match[2]))
    .filter((value) => typeof value === "string" && value.startsWith("/")));
}

function scenarioSpecFiles() {
  return ["journeys", "gates"].flatMap((directory) => sourceFiles(path.join(integrationRoot, directory)).filter((file) => file.endsWith(".spec.ts")));
}

/**
 * 执行档是显式的风险边界。路径只能命中一个档案，避免真实资源、部署
 * 验收或 Go supplier 被默认 local-core 误运行，也避免一个 spec 被重复收集。
 */
const EXECUTION_PROFILES = [
  { name: "local-core", pattern: /^(?:journeys\/local|gates\/local)\/[^/]+\.spec\.ts$/u },
  { name: "dev-http", pattern: /^gates\/dev-http\/[^/]+\.spec\.ts$/u },
  { name: "lifecycle", pattern: /^gates\/lifecycle\/[^/]+\.spec\.ts$/u },
  { name: "msfile", pattern: /^(?:gates|journeys)\/msfile\/[^/]+\.spec\.ts$/u },
  { name: "satsubscription", pattern: /^journeys\/satsubscription\/[^/]+\.spec\.ts$/u },
  { name: "deployment", pattern: /^(?:journeys\/deployment|gates\/deployment)\/[^/]+\.spec\.ts$/u },
  { name: "real-s3", pattern: /^(?:journeys\/real-resource\/real-s3-(?:initialization|bucket-key-switching)|gates\/real-resource\/resource-safety)\.spec\.ts$/u },
  { name: "real-resource", pattern: /^(?:journeys\/real-resource\/(?:real-testnet-asset|real-satsubscription-health|real-satsubscription-page)|resources\/(?:resource-setup|resource-teardown|real-resource-availability))\.spec\.ts$/u },
  { name: "real-s3", pattern: /^resources\/s3-resource-(?:setup|teardown)\.spec\.ts$/u },
];

function validateSpecLayout() {
  const e2eRoot = path.join(root, "e2e");
  const rootSpecs = fs.readdirSync(e2eRoot, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".spec.ts"))
    .map((entry) => `e2e/${entry.name}`);
  if (rootSpecs.length > 0) fail(`e2e 根目录仍有未归一化 spec：${rootSpecs.join(", ")}`);
  if (fs.existsSync(path.join(e2eRoot, "fixtures"))) {
    fail("e2e/fixtures 已废弃；所有 E2E fixture 必须归一到 e2e/integration/fixtures");
  }
  const integrationSpecs = sourceFiles(integrationRoot).filter((file) => file.endsWith(".spec.ts"));
  for (const file of integrationSpecs) {
    const relativeFile = path.relative(integrationRoot, file).replaceAll(path.sep, "/");
    const matches = EXECUTION_PROFILES.filter((profile) => profile.pattern.test(relativeFile));
    if (matches.length !== 1) {
      fail(`${path.relative(root, file)} 必须且只能属于一个执行档，当前命中：${matches.map((item) => item.name).join(", ") || "无"}`);
    }
  }
}

function metadataScenarioIds() {
  const metadataPath = path.join(integrationRoot, "support/scenarioMetadata.ts");
  if (!fs.existsSync(metadataPath)) return new Map();
  const text = read(metadataPath);
  const result = new Map();
  const declarations = [...text.matchAll(/export\s+const\s+([A-Za-z0-9_]+)\s*=\s*\{/g)];
  for (let index = 0; index < declarations.length; index += 1) {
    const declaration = declarations[index];
    const start = declaration.index + declaration[0].length;
    const end = declarations[index + 1]?.index ?? text.length;
    const id = text.slice(start, end).match(/\bid:\s*["']((?:J|G)-[A-Z0-9-]+)["']/u)?.[1];
    if (id) result.set(declaration[1], id);
  }
  return result;
}

function metadataScenarioLevels() {
  const metadataPath = path.join(integrationRoot, "support/scenarioMetadata.ts");
  if (!fs.existsSync(metadataPath)) return new Map();
  const text = read(metadataPath);
  const result = new Map();
  const declarations = [...text.matchAll(/export\s+const\s+([A-Za-z0-9_]+)\s*=\s*\{/g)];
  for (let index = 0; index < declarations.length; index += 1) {
    const declaration = declarations[index];
    const start = declaration.index + declaration[0].length;
    const end = declarations[index + 1]?.index ?? text.length;
    const level = text.slice(start, end).match(/\blevel:\s*["']([^"']+)["']/u)?.[1];
    if (level) result.set(declaration[1], level);
  }
  return result;
}

function expectedScenarioLevel(relativeFile) {
  if (/^(?:journeys\/(?:local|msfile)|gates\/(?:local|dev-http|lifecycle|msfile))\//u.test(relativeFile)) return "local-integration";
  if (/^(?:journeys\/(?:real-resource|satsubscription)|gates\/real-resource)\//u.test(relativeFile)) return "real-resource";
  if (/^(?:journeys\/deployment|gates\/deployment)\//u.test(relativeFile)) return "deployment-acceptance";
  return undefined;
}

function resolveScenarioExpression(expression, localIds, metadataIds) {
  const value = expression.trim().replace(/[,;]+$/u, "");
  const literal = value.match(/^["']((?:J|G)-[A-Z0-9-]+)["']$/u);
  if (literal) return literal[1];
  const property = value.match(/^([A-Za-z0-9_]+)\.id$/u);
  if (property) return localIds.get(property[1]) ?? metadataIds.get(property[1]);
  return localIds.get(value) ?? metadataIds.get(value);
}

function collectScenarioDeclarations() {
  const metadataIds = metadataScenarioIds();
  const metadataLevels = metadataScenarioLevels();
  const declarations = new Map();
  for (const file of scenarioSpecFiles()) {
    const text = read(file);
    const relativeFile = path.relative(integrationRoot, file).replaceAll(path.sep, "/");
    const idMatch = text.match(/export\s+const\s+(JOURNEY_ID|GATE_ID)\s*=\s*([^;]+);/u);
    if (!idMatch) fail(`${path.relative(root, file)} 必须导出 JOURNEY_ID 或 GATE_ID，作为可执行场景编号`);
    const localIds = new Map();
    const id = resolveScenarioExpression(idMatch[2], localIds, metadataIds);
    if (!id) fail(`${path.relative(root, file)} 的 Journey/Gate 编号必须是稳定字符串或可解析 metadata.id`);
    const metadataMatch = text.match(/export\s+const\s+(JOURNEY_METADATA|GATE_METADATA)\s*=\s*([\s\S]*?);/u);
    if (!metadataMatch) fail(`${path.relative(root, file)} 必须同时导出 ${idMatch[1] === "JOURNEY_ID" ? "JOURNEY_METADATA" : "GATE_METADATA"}`);
    localIds.set(idMatch[1], id);
    const metadataId = resolveScenarioExpression(metadataMatch[2], localIds, metadataIds)
      ?? metadataMatch[2].match(/\bid:\s*["']((?:J|G)-[A-Z0-9-]+)["']/u)?.[1]
      ?? (metadataMatch[2].match(/\bid:\s*(JOURNEY_ID|GATE_ID)\b/u)?.[1] ? id : undefined);
    if (metadataId && metadataId !== id) fail(`${path.relative(root, file)} 的 ID 与 metadata.id 不一致：${id} != ${metadataId}`);
    const metadataExpression = metadataMatch[2].trim();
    const metadataName = metadataExpression.match(/^([A-Za-z0-9_]+)$/u)?.[1];
    const actualLevel = (metadataName ? metadataLevels.get(metadataName) : undefined)
      ?? metadataExpression.match(/\blevel:\s*["']([^"']+)["']/u)?.[1];
    const expectedLevel = expectedScenarioLevel(relativeFile);
    if (actualLevel && expectedLevel && actualLevel !== expectedLevel) {
      fail(`${path.relative(root, file)} 的证据层级 ${actualLevel} 与目录执行边界 ${expectedLevel} 不一致`);
    }
    if (declarations.has(id)) fail(`Journey/Gate 编号重复：${id}`);
    declarations.set(id, file);
  }
  return declarations;
}

function collectScenarioIds() {
  return new Set(collectScenarioDeclarations().keys());
}

function collectScenarioRequirementIds() {
  const requirementIds = new Set();
  for (const file of [path.join(integrationRoot, "support/scenarioMetadata.ts"), ...scenarioSpecFiles()]) {
    const text = read(file);
    for (const match of text.matchAll(/\brequirementIds\s*:\s*\[([^\]]*)\]/gu)) {
      for (const id of match[1].matchAll(/["'](KM-[A-Z0-9-]+)["']/gu)) requirementIds.add(id[1]);
    }
  }
  return requirementIds;
}

function exportedConstantValue(packageName, constant) {
  const directory = packageName === "@keymaster/contracts"
    ? path.join(root, "packages/contracts/src")
    : packageName === "apps/web" ? path.join(root, "apps/web/src") : undefined;
  if (!directory) fail(`formal_protocols 的 package 未纳入静态检查：${packageName ?? "缺失"}`);
  const escaped = constant.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`export\\s+const\\s+${escaped}\\s*=\\s*(?:["']([^"']+)["']|([^,;\\n]+))`, "u");
  for (const file of sourceFiles(directory)) {
    const match = read(file).match(pattern);
    if (match) return (match[1] ?? match[2]).trim();
  }
  return undefined;
}

function validateMatrix(matrix, catalog) {
  const plugins = matrix.catalog_plugins;
  const packages = plugins.map((item) => item?.package);
  if (packages.some((item) => typeof item !== "string" || !item.startsWith("@keymaster/"))) fail("每个 catalog_plugins 条目必须有 @keymaster 包名");
  if (new Set(packages).size !== packages.length) fail("catalog_plugins 不允许重复 package；一个正式插件只能有一个盘点条目");
  const actualPackages = catalog.map((item) => item.packageName);
  const missingPackages = sorted(actualPackages.filter((item) => !packages.includes(item)));
  const stalePackages = sorted(packages.filter((item) => !actualPackages.includes(item)));
  if (missingPackages.length) fail(`正式 pluginCatalog 条目未登记：${missingPackages.join(", ")}`);
  if (stalePackages.length) fail(`矩阵登记了不在正式 pluginCatalog 中的包：${stalePackages.join(", ")}`);
  for (const catalogItem of catalog) {
    const declared = plugins.find((item) => item.package === catalogItem.packageName);
    const actualId = staticManifestPluginId(catalogItem.packageName);
    if (declared?.plugin_id !== actualId) fail(`${catalogItem.packageName} 的 plugin_id 与 manifest.id 不一致：${declared?.plugin_id ?? "缺失"} != ${actualId}`);
  }

  const requirements = matrix.requirements;
  const requirementIds = requirements.map((item) => item?.requirement_id);
  if (requirementIds.some((item) => typeof item !== "string" || !/^KM-[A-Z0-9-]+$/u.test(item))) fail("requirement_id 必须使用 KM-... 稳定编号");
  if (new Set(requirementIds).size !== requirementIds.length) fail("requirement_id 不允许重复");
  for (const requirement of requirements) {
    for (const field of REQUIRED_FIELDS) if (!(field in requirement)) fail(`${requirement.requirement_id ?? "未知需求"} 缺少字段 ${field}`);
    if (!LEVELS.has(requirement.gate_level)) fail(`${requirement.requirement_id} 的 gate_level 无效`);
    if (!STATUS.has(requirement.status)) fail(`${requirement.requirement_id} 的 status 无效`);
    if (!Array.isArray(requirement.technical_truths) || requirement.technical_truths.length === 0) fail(`${requirement.requirement_id} 必须声明 technical_truths`);
    if (!Array.isArray(requirement.failure_paths) || requirement.failure_paths.length === 0) fail(`${requirement.requirement_id} 必须声明 failure_paths`);
    if (!Array.isArray(requirement.scenario_ids) || requirement.scenario_ids.some((id) => typeof id !== "string" || !/^(?:J|G)-[A-Z0-9-]+$/u.test(id))) fail(`${requirement.requirement_id} 的 scenario_ids 必须是 J-/G- 场景编号数组`);
    if (requirement.status === "已覆盖" && requirement.scenario_ids.length === 0) fail(`${requirement.requirement_id} 标记为已覆盖但没有可执行场景`);
    if (requirement.status === "未覆盖" && requirement.scenario_ids.length > 0) fail(`${requirement.requirement_id} 标记为未覆盖但已经登记场景；应改为部分覆盖或移除未执行场景`);
  }

  const scenarioIds = collectScenarioIds();
  const referenced = requirements.flatMap((item) => item.scenario_ids);
  const unknownScenarios = sorted(unique(referenced.filter((id) => !scenarioIds.has(id))));
  if (unknownScenarios.length) fail(`矩阵引用了不存在的 Journey/Gate：${unknownScenarios.join(", ")}`);
  const orphanScenarios = sorted([...scenarioIds].filter((id) => !referenced.includes(id)));
  if (orphanScenarios.length) fail(`可执行 Journey/Gate 没有进入覆盖矩阵：${orphanScenarios.join(", ")}`);

  const matrixRequirementIds = new Set(requirementIds);
  const unknownScenarioRequirements = sorted([...collectScenarioRequirementIds()].filter((id) => !matrixRequirementIds.has(id)));
  if (unknownScenarioRequirements.length) fail(`Journey/Gate 元数据引用了不存在的需求：${unknownScenarioRequirements.join(", ")}`);

  const routesByPackage = new Map(plugins.map((item) => [item.package, new Set(item.routes ?? [])]));
  for (const catalogItem of catalog) {
    const actualRoutes = staticManifestRoutes(catalogItem.packageName);
    const declared = routesByPackage.get(catalogItem.packageName);
    const missingRoutes = actualRoutes.filter((route) => !declared?.has(route));
    const staleRoutes = [...(declared ?? [])].filter((route) => !actualRoutes.includes(route));
    if (missingRoutes.length) fail(`${catalogItem.packageName} 的正式 route 未登记到覆盖矩阵：${missingRoutes.join(", ")}`);
    if (staleRoutes.length) fail(`${catalogItem.packageName} 的矩阵 route 不存在于 manifest：${staleRoutes.join(", ")}`);
  }

  for (const protocol of matrix.formal_protocols) {
    if (!protocol || typeof protocol.constant !== "string" || typeof protocol.中文含义 !== "string") fail("formal_protocols 每项必须有 constant 和中文含义");
    const actualValue = exportedConstantValue(protocol.package, protocol.constant);
    if (actualValue === undefined) fail(`formal_protocols 的常量不存在：${protocol.constant}`);
    if (protocol.value !== undefined && String(protocol.value) !== actualValue) fail(`formal_protocols 的值与代码不一致：${protocol.constant}=${actualValue}，矩阵=${protocol.value}`);
  }
}

function escapeCell(value) {
  return String(value).replaceAll("|", "\\|").replaceAll("\n", "<br>");
}

function generatedMarkdown(matrix) {
  const rows = matrix.requirements;
  const counts = Object.fromEntries([...STATUS].map((status) => [status, rows.filter((row) => row.status === status).length]));
  const lines = [
    "# 覆盖矩阵（自动生成）",
    "",
    "> 真值来源：`覆盖矩阵.yaml`。本页只展示需求和证据边界，不把未执行的真实资源或部署测试标成通过。",
    "",
    `共 ${rows.length} 项需求：已覆盖 ${counts["已覆盖"]}，部分覆盖 ${counts["部分覆盖"]}，未覆盖 ${counts["未覆盖"]}，阻断 ${counts["阻断"]}。`,
    "",
    "| 编号 | 业务域 | 用户目标 | 开始状态 | 成功结果 | 技术事实 | 失败/恢复 | 资源 | 层级 | 场景 | 证据 | 状态 |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  ];
  for (const row of rows) {
    lines.push(`| ${escapeCell(row.requirement_id)} | ${escapeCell(row.business_domain)} | ${escapeCell(row.user_goal)} | ${escapeCell(row.starting_state)} | ${escapeCell(row.expected_result)} | ${escapeCell(row.technical_truths.join("；"))} | ${escapeCell(row.failure_paths.join("；"))} | ${escapeCell(row.resource_profile)} | ${escapeCell(row.gate_level)} | ${escapeCell(row.scenario_ids.join("、") || "—")} | ${escapeCell(row.evidence)} | ${escapeCell(row.status)} |`);
  }
  lines.push("", "## 资源与清理索引", "", "| 编号 | 资源声明 | 清理规则 |", "| --- | --- | --- |");
  for (const row of rows) lines.push(`| ${escapeCell(row.requirement_id)} | ${escapeCell(row.resource_profile)} | ${escapeCell(row.cleanup_policy)} |`);
  lines.push("", "## 执行档边界", "", "| 执行档 | 目录 | 中文含义 |", "| --- | --- | --- |", "| local-core | `journeys/local`、`gates/local` | 普通本地浏览器 Journey 与本地 Gate |", "| dev-http | `gates/dev-http` | 非安全 HTTP 开发服务器回归 |", "| lifecycle | `gates/lifecycle` | 本地/registry Coordinator 生命周期验收 |", "| msfile | `journeys/msfile`、`gates/msfile` | 需要临时 Go supplier 的 MSFile 页面 Journey 与技术 Gate |", "| real-resource | `journeys/real-resource`、`resources` | 受保护 testnet/SatSubscription 真实资源 |", "| real-s3 | `journeys/real-resource/real-s3-initialization`、`gates/real-resource/resource-safety` 与 S3 resource | 受保护真实 S3 资源 |", "| deployment | `journeys/deployment`、`gates/deployment` | 目标部署和不可逆 I/O 验收 |");
  return lines.join("\n");
}

const matrix = parseMatrix();
const catalog = catalogPackages();
validateSpecLayout();
validateE2EBrowserBoundary();
validateMatrix(matrix, catalog);
const generated = generatedMarkdown(matrix);
if (process.argv.includes("--write")) {
  fs.writeFileSync(markdownPath, generated, "utf8");
  console.log(`[integration-coverage] 已生成 ${path.relative(root, markdownPath)}`);
} else {
  if (!fs.existsSync(markdownPath)) fail("覆盖矩阵.md 不存在；先运行 node scripts/check-integration-coverage.mjs --write");
  if (read(markdownPath) !== generated) fail("覆盖矩阵.md 与 YAML 真值不一致；运行 --write 后提交生成结果");
}
console.log(`[integration-coverage] 通过：${matrix.requirements.length} 项需求，${catalog.length} 个正式插件，${collectScenarioIds().size} 个可执行 Journey/Gate，所有 spec 已归一化到 e2e/integration。`);
