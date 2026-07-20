// React resource boundary gate. This intentionally uses the TypeScript AST;
// regexes cannot distinguish JSX event props from business subscriptions.
import ts from "typescript";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const root = process.cwd();
const violations = [];
const forbidden = new Set([
  "onActiveChange", "onInitializationChange", "onStatusChange",
  "onSyncStatusChange", "onPresenceChange", "onActivePokerKeyChange",
  "onDataChanged", "onGlobalSettingsChange", "subscribe", "onChange"
]);

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    if (["node_modules", "dist", ".git"].includes(name)) return [];
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : /\.tsx$/.test(name) ? [path] : [];
  });
}

const scanDirs = [join(root, "apps", "web", "src"), ...readdirSync(join(root, "packages"))
  .filter((name) => name.startsWith("plugin-")).map((name) => join(root, "packages", name, "src"))];

function isComponent(node) {
  if (ts.isFunctionDeclaration(node)) return /^[A-Z]/.test(node.name?.text ?? "");
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && /^[A-Z]/.test(node.name.text)) {
    return !!node.initializer && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer));
  }
  return false;
}

function inside(node, ancestor) {
  for (let p = node.parent; p; p = p.parent) if (p === ancestor) return true;
  return false;
}

for (const file of scanDirs.flatMap((dir) => { try { return walk(dir); } catch { return []; } })) {
  const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const components = [];
  function collect(node) {
    if (isComponent(node)) components.push(node);
    ts.forEachChild(node, collect);
  }
  collect(source);
  for (const component of components) {
    function scan(node) {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
        const method = node.expression.name.text;
        if (forbidden.has(method)) {
          // DOM listeners and JSX event props are not CallExpressions here;
          // allow an explicitly narrow editor safety subscription only.
          const text = source.getFullText();
          const narrowEditorException = file.endsWith("ContactsEditor.tsx") &&
            text.includes("@resource-boundary allow: active-key-editor-safety") &&
            method === "onActiveChange";
          if (!narrowEditorException) {
            const pos = source.getLineAndCharacterOfPosition(node.getStart(source));
            violations.push(`${relative(root, file)}:${pos.line + 1}:${pos.character + 1}: direct business subscription ${method}(); use Resource Store`);
          }
        }
      }
      ts.forEachChild(node, scan);
    }
    // A nested helper belongs to the component as well; scan its full body.
    scan(component.body ?? component);
  }
}

if (violations.length) {
  console.error("React resource boundary violations:");
  for (const violation of [...new Set(violations)]) console.error(`- ${violation}`);
  process.exit(1);
}
console.log("React resource boundaries are clean.");
