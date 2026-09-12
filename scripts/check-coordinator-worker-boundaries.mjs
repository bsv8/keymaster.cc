// Coordinator SharedWorker module-boundary gate.
//
// Vite's React plugin transforms every reachable TSX module in development,
// including a module loaded by a SharedWorker. The transformed module imports
// `/@react-refresh`, whose runtime assumes `window`; that makes the Worker die
// before it can publish its ready snapshot. This gate follows the actual
// TypeScript/ESM source graph from the Worker entrypoint and fails on the
// classes of imports that can recreate that failure.

import ts from "typescript";
import { createRequire } from "node:module";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";

const root = process.cwd();
const entry = resolve(root, "apps/web/src/keymasterSessionCoordinator.worker.ts");
const appRequire = createRequire(resolve(root, "apps/web/package.json"));
const violations = [];
const unresolvedWorkspaceImports = [];
const unresolvedLocalImports = [];
const visited = new Set();

function display(file) {
  return relative(root, file) || file;
}

function isInsideWorkspace(file) {
  const path = realpathSync(file);
  return path === root || path.startsWith(`${root}/`);
}

function sourceCandidates(path) {
  const candidates = [path];
  if (extname(path) === ".js") candidates.push(path.slice(0, -3) + ".ts", path.slice(0, -3) + ".tsx");
  if (extname(path) === ".mjs") candidates.push(path.slice(0, -4) + ".mts");
  if (!extname(path)) candidates.push(`${path}.ts`, `${path}.tsx`, `${path}.js`, `${path}.jsx`);
  candidates.push(join(path, "index.ts"), join(path, "index.tsx"));
  return candidates;
}

function resolveLocalSpecifier(specifier, importer) {
  const base = specifier.startsWith("/")
    ? resolve(root, `.${specifier}`)
    : resolve(dirname(importer), specifier);
  for (const candidate of sourceCandidates(base)) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return realpathSync(candidate);
  }
  return undefined;
}

function resolveSpecifier(specifier, importer) {
  if (specifier.startsWith(".") || specifier.startsWith("/")) {
    return resolveLocalSpecifier(specifier, importer);
  }
  try {
    return realpathSync(appRequire.resolve(specifier));
  } catch {
    // ESM-only third-party packages can reject createRequire resolution even
    // though Vite resolves them correctly. We only need to walk workspace
    // source here; direct forbidden package specifiers are checked below.
    if (specifier.startsWith("@keymaster/")) unresolvedWorkspaceImports.push({ importer, specifier });
    return undefined;
  }
}

function importText(source, node) {
  return source.text.slice(node.moduleSpecifier.getStart(source) + 1, node.moduleSpecifier.getEnd() - 1);
}

function hasRuntimeImportClause(importClause) {
  if (!importClause || importClause.isTypeOnly) return false;
  if (importClause.name) return true;
  if (!importClause.namedBindings) return false;
  if (ts.isNamespaceImport(importClause.namedBindings)) return true;
  return importClause.namedBindings.elements.some((element) => !element.isTypeOnly);
}

function isStaticModuleSpecifier(expression) {
  return ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression);
}

function collectRuntimeImports(sourceFile) {
  const imports = [];
  function visit(node) {
    if (ts.isImportDeclaration(node)) {
      // `import "./side-effect.ts"` has no ImportClause but is still a runtime
      // edge. Type-only declarations remain excluded by hasRuntimeImportClause.
      if (!node.importClause || hasRuntimeImportClause(node.importClause)) {
        imports.push({ specifier: importText(sourceFile, node), node });
      }
    } else if (ts.isExportDeclaration(node)) {
      if (!node.moduleSpecifier || node.isTypeOnly) return;
      if (!node.exportClause || ts.isNamespaceExport(node.exportClause)) {
        imports.push({ specifier: importText(sourceFile, node), node });
      } else if (ts.isNamedExports(node.exportClause) && node.exportClause.elements.some((element) => !element.isTypeOnly)) {
        imports.push({ specifier: importText(sourceFile, node), node });
      }
    } else if (ts.isImportEqualsDeclaration(node)) {
      if (node.isTypeOnly || !ts.isExternalModuleReference(node.moduleReference)) return;
      const expression = node.moduleReference.expression;
      if (isStaticModuleSpecifier(expression)) {
        imports.push({ specifier: expression.text, node });
      } else {
        imports.push({
          node,
          violation: "Worker runtime contains a non-static import-equals external module reference",
        });
      }
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const [argument] = node.arguments;
      if (argument && isStaticModuleSpecifier(argument)) {
        imports.push({ specifier: argument.text, node });
      } else {
        imports.push({ node, violation: "Worker runtime contains a non-static dynamic import()" });
      }
    } else if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "require") {
      const [argument] = node.arguments;
      if (argument && isStaticModuleSpecifier(argument)) {
        imports.push({ specifier: argument.text, node });
      } else {
        imports.push({ node, violation: "Worker runtime contains a non-static require()" });
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return imports;
}

function recordViolation(file, node, message) {
  const position = ts.getLineAndCharacterOfPosition(node.getSourceFile(), node.getStart(node.getSourceFile()));
  violations.push(`${display(file)}:${position.line + 1}:${position.character + 1}: ${message}`);
}

function inspectImport(file, node, specifier, resolved) {
  if (specifier === "@keymaster/runtime") {
    recordViolation(file, node, "Worker runtime code must import @keymaster/runtime/storage or contracts, never the Window runtime barrel");
  }
  if (specifier.startsWith("@keymaster/runtime/") && specifier !== "@keymaster/runtime/storage") {
    recordViolation(file, node, `Worker runtime code may only import the worker-safe @keymaster/runtime/storage entrypoint (found ${specifier})`);
  }
  if (specifier === "react" || specifier === "react-dom" || specifier === "webloom-framework/react" || specifier === "@vitejs/plugin-react" || specifier.includes("react-refresh")) {
    recordViolation(file, node, `Worker runtime code must not import ${specifier}`);
  }
  if (resolved && isInsideWorkspace(resolved)) {
    if (resolved.includes("/node_modules/")) return;
    if (resolved.endsWith("/packages/runtime/src/index.ts")) {
      recordViolation(file, node, `Worker runtime reached the Window runtime barrel: ${display(resolved)}`);
    }
    if (resolved.endsWith(".tsx") || resolved.endsWith(".jsx")) {
      recordViolation(file, node, `Worker runtime reached a JSX module: ${display(resolved)}`);
    }
  }
}

function walk(file) {
  if (!file || visited.has(file)) return;
  visited.add(file);
  if (!isInsideWorkspace(file) || file.includes("/node_modules/")) return;
  if (/\.(?:tsx|jsx)$/u.test(file)) {
    violations.push(`${display(file)}: Worker runtime graph contains a JSX module`);
    return;
  }
  const sourceText = readFileSync(file, "utf8");
  const sourceFile = ts.createSourceFile(file, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  for (const imported of collectRuntimeImports(sourceFile)) {
    if (imported.violation) {
      recordViolation(file, imported.node, imported.violation);
      continue;
    }
    const { specifier, node } = imported;
    const resolved = resolveSpecifier(specifier, file);
    if (!resolved && (specifier.startsWith(".") || specifier.startsWith("/"))) {
      unresolvedLocalImports.push({ importer: file, specifier });
    }
    inspectImport(file, node, specifier, resolved);
    if (resolved && isInsideWorkspace(resolved) && !resolved.includes("/node_modules/")) walk(resolved);
  }
}

if (!existsSync(entry)) {
  console.error(`Coordinator Worker entrypoint is missing: ${display(entry)}`);
  process.exit(1);
}

walk(realpathSync(entry));

for (const { importer, specifier } of unresolvedWorkspaceImports) {
  const message = `${display(importer)}: workspace import could not be resolved: ${specifier}`;
  if (!violations.includes(message)) violations.push(message);
}
for (const { importer, specifier } of unresolvedLocalImports) {
  const message = `${display(importer)}: local Worker import could not be resolved: ${specifier}`;
  if (!violations.includes(message)) violations.push(message);
}

if (violations.length > 0) {
  console.error("Coordinator SharedWorker module boundary violations:");
  for (const violation of [...new Set(violations)]) console.error(`- ${violation}`);
  process.exit(1);
}

console.log(`Coordinator SharedWorker module boundary is clean (${visited.size} workspace modules checked).`);
