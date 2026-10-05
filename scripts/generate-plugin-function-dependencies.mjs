// 从能力类型和实际调用点提取函数依赖；生成物只包含静态事实，不加载插件实现。
import ts from "typescript";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { resolve, relative } from "node:path";
const root = process.cwd();
const definitions = readFileSync(resolve(root, "packages/contracts/src/generated/pluginDefinitions.ts"), "utf8");
const catalog = JSON.parse(definitions.slice(definitions.indexOf("["), definitions.lastIndexOf("]") + 1));
function sources(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    if (["node_modules", "dist", "generated", "testSupport", "testing", "testFixtures", "behaviorFixtures"].includes(entry.name)) return [];
    const path = resolve(directory, entry.name);
    return entry.isDirectory() ? sources(path) : /\.tsx?$/.test(path) && !/\.(test|spec|typecheck|testSupport)\./.test(path) ? [path] : [];
  });
}
const paths = sources(resolve(root, "packages"));
const config = ts.readConfigFile(resolve(root, "tsconfig.base.json"), ts.sys.readFile);
const options = ts.parseJsonConfigFileContent(config.config, ts.sys, root).options;
const program = ts.createProgram(paths, options);
const checker = program.getTypeChecker();
const methodCapabilities = new Map();
const capKey = cap => `${cap.kind}:${cap.id}@${cap.version}`;
const descriptors = new Map(catalog.flatMap(plugin => plugin.units.flatMap(unit => [...(unit.provides ?? []), ...(unit.privateProvides ?? []), ...(unit.dependencies ?? []).map(dep => dep.capability)])).map(cap => [capKey(cap), cap]));
function declarationKey(declaration) { return declaration.getSourceFile().fileName + ":" + declaration.pos; }
function registerMethods(type, capability, prefix = "", depth = 0, visited = new Set()) {
  if (depth > 3 || visited.has(type)) return;
  const nextVisited = new Set(visited).add(type);
  if (type.isUnionOrIntersection()) { for (const part of type.types) registerMethods(part, capability, prefix, depth, nextVisited); return; }
  for (const property of type.getProperties()) {
    const declaration = property.valueDeclaration ?? property.declarations?.[0];
    if (!declaration) continue;
    const propertyType = checker.getTypeOfSymbolAtLocation(property, declaration);
    const signatures = propertyType.getCallSignatures();
    const method = prefix + property.name;
    if (signatures.length) {
      for (const target of property.declarations ?? []) {
        if (target.getSourceFile().fileName.includes("node_modules")) continue;
        const key = declarationKey(target);
        const entries = methodCapabilities.get(key) ?? [];
        if (!entries.some(entry => entry.key === capKey(capability) && entry.method === method)) entries.push({ key: capKey(capability), method, capability });
        methodCapabilities.set(key, entries);
      }
      // 受限工厂 / Scope 绑定返回的操作面也归此能力，停止于业务调用返回值。
      if (/^(bind|open|borrow|create)/.test(property.name)) for (const signature of signatures) registerMethods(checker.getReturnTypeOfSignature(signature), capability, method + ".", depth + 1, nextVisited);
    } else if (["view", "reader", "client"].includes(property.name)) registerMethods(propertyType, capability, prefix + property.name + ".", depth + 1, nextVisited);
  }
}
for (const file of program.getSourceFiles()) {
  if (!paths.includes(file.fileName)) continue;
  function visit(node) {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "defineCapability" && node.typeArguments?.[0] && node.arguments[0] && ts.isObjectLiteralExpression(node.arguments[0])) {
      const fields = {};
      for (const property of node.arguments[0].properties) if (ts.isPropertyAssignment(property) && ["id", "kind", "version"].includes(property.name.getText(file))) {
        const type = checker.getTypeAtLocation(property.initializer);
        if (type.isStringLiteral()) fields[property.name.getText(file)] = type.value;
      }
      const capability = descriptors.get(capKey(fields));
      if (capability?.kind === "local") registerMethods(checker.getTypeFromTypeNode(node.typeArguments[0]), capability);
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
}
const packageCatalog = new Map(catalog.map(plugin => [plugin.id === "storage" ? "platform-storage" : "plugin-" + plugin.id, plugin]));
// 两个产品目录沿用其领域包名。
packageCatalog.set("plugin-message", catalog.find(plugin => plugin.id === "message"));
function caller(node, file) {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (ts.isFunctionLike(parent)) {
      if (parent.name) return parent.name.getText(file);
      if (ts.isVariableDeclaration(parent.parent) && ts.isIdentifier(parent.parent.name)) return parent.parent.name.text;
      if (ts.isPropertyAssignment(parent.parent)) return parent.parent.name.getText(file);
    }
  }
  return "module";
}
const calls = [];
for (const path of paths) {
  const packageName = relative(root, path).split("/")[1];
  const plugin = packageCatalog.get(packageName);
  if (!plugin) continue;
  const file = program.getSourceFile(path);
  const declared = new Set(plugin.units.flatMap(unit => [...(unit.dependencies ?? []).map(dep => capKey(dep.capability)), ...(unit.provides ?? []).map(capKey), ...(unit.privateProvides ?? []).map(capKey)]));
  function inspect(node) {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const symbol = checker.getSymbolAtLocation(node.expression.name);
      const matches = (symbol?.declarations ?? []).flatMap(declaration => methodCapabilities.get(declarationKey(declaration)) ?? []).filter(match => declared.has(match.key));
      for (const match of matches) {
        const consumingUnits = plugin.units.filter(unit => (unit.dependencies ?? []).some(dep => capKey(dep.capability) === match.key));
        const providers = catalog.flatMap(product => product.units.filter(unit => [...(unit.provides ?? []), ...(unit.privateProvides ?? [])].some(cap => capKey(cap) === match.key) && consumingUnits.some(consumer => (consumer.dependencies ?? []).some(dep => capKey(dep.capability) === match.key && (dep.source === "peer" ? unit.runtime !== consumer.runtime : unit.runtime === (dep.sourceRuntime ?? consumer.runtime))))).map(unit => ({ pluginId: product.id, unitId: unit.id, runtime: unit.runtime })));
        // 不把插件自己的内部调用当成跨插件依赖。
        for (const provider of providers.filter(provider => provider.pluginId !== plugin.id)) calls.push({ consumer: plugin.id, provider: provider.pluginId, providerUnit: provider.unitId, runtime: provider.runtime, capability: match.capability.id, method: node.expression.name.text, caller: caller(node, file), file: relative(root, path), line: file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1 });
      }
    }
    ts.forEachChild(node, inspect);
  }
  inspect(file);
}
const unique = [...new Map(calls.map(call => [JSON.stringify(call), call])).values()].sort((a, b) => a.consumer.localeCompare(b.consumer) || a.provider.localeCompare(b.provider) || a.file.localeCompare(b.file) || a.line - b.line || a.method.localeCompare(b.method));
const output = '// Generated by scripts/generate-plugin-function-dependencies.mjs; do not edit.\nexport const PLUGIN_FUNCTION_CALLS = ' + '[\n' + unique.map(call => '  ' + JSON.stringify(call)).join(',\n') + '\n]' + ' as const;\n';
const target = resolve(root, "packages/plugin-page/src/settings/generated/functionDependencies.ts");
if (process.argv.includes("--check")) {
  if (readFileSync(target, "utf8") !== output) throw new Error("Plugin function dependencies are stale; run pnpm generate:plugin-dependencies");
} else writeFileSync(target, output);
console.log(`Plugin function dependencies ${process.argv.includes("--check") ? "verified" : "generated"}: ${unique.length} call sites.`);
