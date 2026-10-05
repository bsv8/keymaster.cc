import { readFile, readdir, writeFile } from "node:fs/promises";
import { resolve, relative, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { createServer } from "vite";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const server = await createServer({ root, configFile: false, server: { middlewareMode: true }, ssr: { noExternal: [/^@keymaster\//] } });
const parse = (file, text) => ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
async function sources(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (["node_modules", "dist", "testSupport", "testing"].includes(entry.name)) continue;
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) result.push(...await sources(path));
    else if (/\.(ts|tsx)$/.test(path) && !/\.(test|spec|typecheck|testSupport)\./.test(path)) result.push(path);
  }
  return result;
}
const cell = value => String(value).replaceAll("|", "\\|").replaceAll("\n", " ");
try {
  const contracts = await server.ssrLoadModule("/packages/contracts/src/index.ts");
  const framework = await import("webloom-framework");
  const { WEB_PLUGIN_CATALOG_SOURCE: catalog } = await server.ssrLoadModule("/apps/web/src/pluginCatalogSource.ts");
  const catalogText = await readFile(resolve(root, "apps/web/src/pluginCatalogSource.ts"), "utf8");
  const catalogFile = parse("catalog.ts", catalogText);
  const imported = new Map();
  for (const node of catalogFile.statements) if (ts.isImportDeclaration(node) && node.importClause?.namedBindings && ts.isNamedImports(node.importClause.namedBindings)) {
    for (const entry of node.importClause.namedBindings.elements) imported.set(entry.name.text, node.moduleSpecifier.text);
  }
  const packageOrder = [...catalogText.matchAll(/\{ manifest: (\w+), setup:/g)].map(match => imported.get(match[1]));
  if (packageOrder.length !== catalog.length) throw new Error("Catalog package mapping does not match actual products");
  const packages = new Map(catalog.map((plugin, index) => [packageOrder[index].replace("@keymaster/", ""), plugin]));
  const parsedFiles = new Map();
  async function parsed(path) {
    if (!parsedFiles.has(path)) parsedFiles.set(path, parse(path, await readFile(path, "utf8")));
    return parsedFiles.get(path);
  }
  async function localValue(path, name, visited = new Set()) {
    const key = path + ":" + name;
    if (visited.has(key)) return undefined;
    visited.add(key);
    const file = await parsed(path);
    for (const node of file.statements) {
      if (ts.isImportDeclaration(node) && node.importClause?.namedBindings && ts.isNamedImports(node.importClause.namedBindings)) {
        const entry = node.importClause.namedBindings.elements.find(value => value.name.text === name);
        if (!entry) continue;
        const importedName = (entry.propertyName ?? entry.name).text;
        const source = node.moduleSpecifier.text;
        if (source === "@keymaster/contracts") return contracts[importedName];
        if (source === "webloom-framework") return framework[importedName];
        if (source.startsWith(".")) {
          const target = resolve(dirname(path), source.replace(/\.js$/, ".ts"));
          try { return await localValue(target, importedName, visited); } catch { return undefined; }
        }
      }
      if (ts.isVariableStatement(node)) {
        const declaration = node.declarationList.declarations.find(value => ts.isIdentifier(value.name) && value.name.text === name);
        const value = declaration?.initializer;
        if (!value) continue;
        if (ts.isStringLiteral(value)) return value.text;
        if (ts.isIdentifier(value)) return localValue(path, value.text, visited);
        if (ts.isCallExpression(value) && value.expression.getText(file) === "defineCapability" && value.arguments[0] && ts.isObjectLiteralExpression(value.arguments[0])) {
          const fields = {};
          for (const property of value.arguments[0].properties) if (ts.isPropertyAssignment(property) && ["kind", "id", "version"].includes(property.name.getText(file))) {
            const input = property.initializer;
            fields[property.name.getText(file)] = ts.isStringLiteral(input) ? input.text : ts.isIdentifier(input) ? await localValue(path, input.text, new Set(visited)) : undefined;
          }
          if (fields.kind && fields.id && fields.version) return fields;
        }
      }
    }
    return undefined;
  }
  const rows = [];
  const unresolved = [];
  for (const [packageName, plugin] of packages) {
    for (const path of await sources(resolve(root, "packages", packageName, "src"))) {
      const file = await parsed(path);
      const bindings = new Map();
      for (const node of file.statements) if (ts.isImportDeclaration(node) && node.importClause?.namedBindings && ts.isNamedImports(node.importClause.namedBindings)) {
        const namespace = node.moduleSpecifier.text === "@keymaster/contracts" ? contracts : node.moduleSpecifier.text === "webloom-framework" ? framework : undefined;
        for (const entry of node.importClause.namedBindings.elements) bindings.set(entry.name.text, namespace ? namespace[(entry.propertyName ?? entry.name).text] : await localValue(path, entry.name.text));
      }
      for (const node of file.statements) if (ts.isVariableStatement(node)) for (const declaration of node.declarationList.declarations) if (ts.isIdentifier(declaration.name)) bindings.set(declaration.name.text, await localValue(path, declaration.name.text));
      function inspect(node) {
        if (ts.isCallExpression(node) && ((ts.isPropertyAccessExpression(node.expression) && ["capability", "optionalCapability", "privateCapability"].includes(node.expression.name.text)) || (ts.isIdentifier(node.expression) && node.expression.text === "subscribeOptionalMessageService"))) {
          const arg = node.arguments[ts.isIdentifier(node.expression) ? 1 : 0];
          const point = file.getLineAndCharacterOfPosition(node.getStart(file));
          const location = `${relative(root, path)}:${point.line + 1}`;
          const args = arg && ts.isConditionalExpression(arg) ? [arg.whenTrue, arg.whenFalse] : [arg];
          for (const input of args) {
            const cap = input && ts.isIdentifier(input) ? bindings.get(input.text) : undefined;
            if (!cap?.id || !cap?.kind || !cap?.version) { unresolved.push([plugin.id, location, input?.getText(file) ?? "missing argument"]); continue; }
            const identity = `${cap.id}@${cap.version} (${cap.kind})`;
            const deps = plugin.units.flatMap(unit => (unit.dependencies ?? []).filter(dep => dep.capability.id === cap.id && dep.capability.kind === cap.kind && dep.capability.version === cap.version).map(dep => `${unit.id} ← ${dep.sourceRuntime ?? dep.source ?? "same runtime"}${dep.optional ? " (optional)" : ""}`));
            const providers = plugin.units.filter(unit => [...(unit.provides ?? []), ...(unit.privateProvides ?? [])].some(value => value.id === cap.id && value.version === cap.version && value.kind === cap.kind)).map(unit => `${unit.id} (own provider)`);
            const declaration = [...deps, ...providers];
            rows.push([plugin.id, location, node.expression.getText(file), identity, declaration.join("<br>") || "UNDECLARED"]);
          }
        }
        ts.forEachChild(node, inspect);
      }
      inspect(file);
    }
  }
  const lines = ["# WebLoom 0.6 能力调用位置盘点", "", "由 `node scripts/generate-webloom-call-inventory.mjs` 对发行版插件生产源码的 TypeScript AST 生成，逐条记录实际能力解析位置并连接真实单元声明。排除测试与测试支持目录。", "", "此表检查能力入口；服务内部调用与可信 Worker 注入接口另见施工单的领域归属表。私有代理与动态授权解析保留原表达式，不能视为已证明授权。一个插件有多个单元时，下表列出候选声明；具体 consumer/Scope 与来源由运行时绑定及对应回归测试验证。", "", "| 插件 | 源码位置 | 实际解析入口 | 能力 | 所属单元与来源声明 |", "| --- | --- | --- | --- | --- |"];
  for (const row of rows) lines.push(`| ${row.map(cell).join(" | ")} |`);
  lines.push("", "## 动态或包内私有解析", "", "| 插件 | 源码位置 | 原表达式 |", "| --- | --- | --- |");
  for (const row of unresolved) lines.push(`| ${row.map(cell).join(" | ")} |`);
  lines.push("", `共 ${rows.length} 个可解析入口，${unresolved.length} 个动态/私有入口。`);
  await writeFile(resolve(root, "docs/proposals/webloom-0.6/能力调用盘点.md"), lines.join("\n") + "\n");
  const missing = rows.filter(row => row[4] === "UNDECLARED");
  if (missing.length) throw new Error(`Undeclared capability calls:\n${missing.map(row => row.join(" ")).join("\n")}`);
  console.log(`Inventoried ${rows.length} declared capability calls and ${unresolved.length} dynamic/private calls across ${catalog.length} products.`);
} finally { await server.close(); }
