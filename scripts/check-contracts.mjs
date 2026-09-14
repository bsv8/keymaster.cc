import { readFile, readdir, stat } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

/**
 * 契约结构检查器。
 *
 * 这里只读取 contracts 源码，不生成或比较重复的清单文件。它检查：
 * - defineCapability 的 kind/id/version 是否为完整字符串；
 * - 契约身份是否重复；
 * - RPC 的 request/response、stream 的 request/item 解析器是否存在。
 * TypeScript 类型检查和契约行为测试由 package.json 中的命令负责。
 */

const defaultRoot = fileURLToPath(new URL("..", import.meta.url));
const argv = process.argv.slice(2);
const sourcePattern = /\.(?:ts|tsx)$/u;
const testPattern = /(?:\.test|\.spec|\.typecheck)\.(?:ts|tsx)$/u;

function optionValues(name) {
  const values = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === name && argv[index + 1]) values.push(argv[index + 1]);
  }
  return values;
}

const root = resolve(optionValues("--root")[0] ?? defaultRoot);
const sourceRoots = (optionValues("--source-root").length > 0
  ? optionValues("--source-root")
  : ["packages/contracts/src"])
  .map((value) => resolve(root, value));

function rel(path) {
  return relative(root, path).split(sep).join("/");
}

async function filesUnder(directory) {
  try {
    if (!(await stat(directory)).isDirectory()) return [];
  } catch {
    return [];
  }
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...await filesUnder(path));
    else if (sourcePattern.test(entry.name) && !testPattern.test(entry.name)) files.push(path);
  }
  return files;
}

async function filesAt(path) {
  try {
    const information = await stat(path);
    if (information.isDirectory()) return filesUnder(path);
    return sourcePattern.test(path) && !testPattern.test(path) ? [path] : [];
  } catch {
    return [];
  }
}

function literalText(node) {
  return ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) ? node.text : undefined;
}

function propertyExpression(object, name) {
  if (!object || !ts.isObjectLiteralExpression(object)) return undefined;
  const property = object.properties.find((candidate) => (
    (ts.isPropertyAssignment(candidate) || ts.isShorthandPropertyAssignment(candidate))
      && ((ts.isIdentifier(candidate.name) && candidate.name.text === name)
        || (ts.isStringLiteral(candidate.name) && candidate.name.text === name))
  ));
  return property && ts.isPropertyAssignment(property) ? property.initializer : property?.name;
}

function isDefineCapability(call, sourceFile) {
  if (!ts.isIdentifier(call.expression)) return false;
  if (call.expression.text === "defineCapability") return true;
  return sourceFile.statements.some((statement) => (
    ts.isImportDeclaration(statement)
      && statement.importClause?.namedBindings
      && ts.isNamedImports(statement.importClause.namedBindings)
      && statement.importClause.namedBindings.elements.some((element) => (
        element.name.text === call.expression.text
        && (element.propertyName?.text ?? element.name.text) === "defineCapability"
      ))
  ));
}

function location(sourceFile, node) {
  const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  return `${rel(sourceFile.fileName)}:${position.line + 1}`;
}

function hasParser(object, name) {
  const expression = propertyExpression(object, name);
  if (!expression) return false;
  return !(ts.isIdentifier(expression) && expression.text === "undefined")
    && expression.kind !== ts.SyntaxKind.NullKeyword;
}

function scan(sourceFiles) {
  const errors = [];
  const entries = [];
  for (const path of sourceFiles) {
    const text = sourceTexts.get(path);
    const sourceFile = ts.createSourceFile(
      path,
      text,
      ts.ScriptTarget.Latest,
      true,
      path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    const visit = (node) => {
      if (ts.isCallExpression(node) && isDefineCapability(node, sourceFile)) {
        const where = location(sourceFile, node);
        const argument = node.arguments[0];
        if (!argument || !ts.isObjectLiteralExpression(argument)) {
          errors.push(`${where} defineCapability 必须接收静态对象`);
        } else {
          const kind = literalText(propertyExpression(argument, "kind"));
          const id = literalText(propertyExpression(argument, "id"));
          const version = literalText(propertyExpression(argument, "version"));
          if (!kind || !id || !version) {
            errors.push(`${where} kind/id/version 必须是非空字符串字面量`);
          } else if (!["local", "rpc", "stream"].includes(kind)) {
            errors.push(`${where} kind ${JSON.stringify(kind)} 无效，只允许 local、rpc、stream`);
          } else {
            const parserFields = kind === "rpc" ? ["request", "response"] : kind === "stream" ? ["request", "item"] : [];
            for (const field of parserFields) {
              if (!hasParser(argument, field)) errors.push(`${where} ${kind} 契约缺少 ${field} 解析器`);
            }
            entries.push({ kind, id, version, where });
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    ts.forEachChild(sourceFile, visit);
  }

  const seen = new Map();
  for (const entry of entries) {
    const key = `${entry.kind}\u0000${entry.id}\u0000${entry.version}`;
    if (seen.has(key)) errors.push(`契约身份重复 ${entry.kind}/${entry.id}/${entry.version}：${seen.get(key)} 与 ${entry.where}`);
    else seen.set(key, entry.where);
  }
  return { entries, errors };
}

const sourceFiles = [...new Set((await Promise.all(sourceRoots.map(filesAt))).flat())];
const sourceTexts = new Map();
for (const path of sourceFiles) {
  sourceTexts.set(path, await readFile(path, "utf8"));
}

if (sourceFiles.length === 0) {
  console.error("契约检查失败：未找到 contracts 源码");
  process.exitCode = 1;
} else {
  const result = scan(sourceFiles);
  if (result.entries.length === 0) result.errors.push("未发现 defineCapability 契约");
  if (result.errors.length > 0) {
    console.error("契约结构检查失败：");
    for (const error of result.errors) console.error(`- ${error}`);
    process.exitCode = 1;
  } else {
    const counts = result.entries.reduce((summary, entry) => {
      summary[entry.kind] = (summary[entry.kind] ?? 0) + 1;
      return summary;
    }, {});
    console.log(`契约结构检查通过：${result.entries.length} 个契约（local ${counts.local ?? 0}、rpc ${counts.rpc ?? 0}、stream ${counts.stream ?? 0}）`);
  }
}
