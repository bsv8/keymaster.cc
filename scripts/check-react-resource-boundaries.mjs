// React resource boundary gate. This intentionally uses the TypeScript AST;
// regexes cannot distinguish JSX event props from business subscriptions.
import ts from "typescript";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const root = process.cwd();
const violations = [];
const forbidden = new Set([
  "onActiveChange", "onInitializationChange", "onStatusChange",
  "onSyncStatusChange", "onPresenceChange",
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
          const narrowEditorException = (
            (relative(root, file) === "packages/plugin-contacts/src/ContactsEditor.tsx" &&
              text.includes("@resource-boundary allow: active-key-editor-safety")) ||
            (relative(root, file) === "packages/plugin-apps/src/AppLaunchModal.tsx" &&
              text.includes("@resource-boundary allow: wallet-session-form-safety"))
          ) && method === "subscribe" && ts.isIdentifier(node.expression.expression)
            && node.expression.expression.text === "walletState";
          const pageRendererSubscription = relative(root, file) === "apps/web/src/App.tsx" &&
            component.name?.text === "ApplicationFrame" && method === "subscribe" &&
            ts.isIdentifier(node.expression.expression) && node.expression.expression.text === "pages";
          if (!narrowEditorException && !pageRendererSubscription) {
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

// 已迁移的业务 UI 不允许重新取得 Host 或框架全局消费入口。
// 暂未迁移的插件仍由施工单逐项收口；这里守住已完成的边界。
const consumerRoots = readdirSync(join(root, "packages")).filter(name => name.startsWith("plugin-")).map(name => join(root, "packages", name, "src")).filter(existsSync);
function consumerFiles(dir) {
  return readdirSync(dir).flatMap(name => {
    if (["node_modules", "dist"].includes(name)) return [];
    const file = join(dir, name);
    return statSync(file).isDirectory() ? consumerFiles(file)
      : /\.(?:ts|tsx)$/.test(name) && !/\.(?:test|spec|typecheck)\./.test(name) && !/testSupport|testFixtures|behaviorFixtures/.test(name) ? [file] : [];
  });
}
const consumerSources = [...consumerRoots.flatMap(consumerFiles), ...consumerFiles(join(root, "packages/platform-storage/src")),
  join(root, "packages/plugin-sat-subscription/src/SatSubscriptionSettings.tsx"),
  join(root, "packages/plugin-webrtc/src/WebrtcSettingsPage.tsx"),
  ...["plugin-message/src/MessagePage.tsx", "plugin-message/src/MessageDetailPage.tsx", "plugin-collectible-1satordinals/src/OrdinalTransferWidget.tsx", "plugin-contacts/src/ContactPicker.tsx", "plugin-contacts/src/ContactsPage.tsx", "plugin-contacts/src/ContactDetailPage.tsx", "plugin-contacts/src/ContactsEditor.tsx", "plugin-contacts/src/ContactPublicKeyActions.tsx", "plugin-p2pkh/src/widgets/P2pkhTransferWidget.tsx", "plugin-p2pkh/src/pages/P2pkhTransferPage.tsx", "plugin-p2pkh/src/pages/P2pkhSettingsPage.tsx", "plugin-woc/src/pages/WocSettingsPage.tsx", "plugin-p2pkh/src/widgets/P2pkhBalanceWidget.tsx", "plugin-contacts/src/RecentContactsWidget.tsx",
    "plugin-msfile/src/MsFileHomeFileWidget.tsx", "plugin-msfile/src/MsFileBucketPage.tsx", "plugin-msfile/src/MsFileMediaPlayer.tsx", "plugin-msfile/src/MsFileSettings.tsx"]
    .map(file => join(root, "packages", file))];
const globalHooks = new Set(["usePluginHost", "useHost", "usePluginRuntime", "useI18n", "useBsvPrice", "useLocale", "useI18nText", "useRegistry", "useRuntimeStatus", "useCapability", "useOptionalCapability", "useHasCapability", "useWebLoomApp", "useAppSubscription", "useRuntimeSelector", "PluginConsumerProvider", "PluginHostContext", "WebLoomContext", "PluginHostProvider", "WebLoomProvider", "createKeymasterPluginHost", "getWebLoomHost", "bindWebLoomHost", "attachKeymasterRemoteRuntime", "registerKeymasterOwnedResource", "createPluginHost", "createWindowApp", "createSharedWorkerRuntime"]);
for (const file of consumerSources) {
  const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const trustedModule = specifier => specifier === "@keymaster/runtime/assembly" || (specifier.startsWith(".") && /(?:assembly|PluginHostProvider|keymasterHostAdapter|pluginHostContract)\.[cm]?[jt]sx?$/.test(specifier));
  const globalModule = specifier => specifier === "@keymaster/runtime" || specifier.startsWith("@keymaster/runtime/")
    || specifier === "webloom-framework/react" || specifier.startsWith("webloom-framework/react/")
    || (specifier.startsWith(".") && resolve(file, "..", specifier).startsWith(join(root, "packages/runtime/src") + "/"));
  function scan(node) {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      if (trustedModule(node.moduleSpecifier.text)) violations.push(`${relative(root, file)}: trusted host assembly is forbidden in plugin code`);
      const bindings = node.importClause?.namedBindings;
      if (globalModule(node.moduleSpecifier.text) && bindings && ts.isNamespaceImport(bindings)) violations.push(`${relative(root, file)}: namespace access bypasses consumer UI imports`);
      if (bindings && ts.isNamedImports(bindings)) for (const entry of bindings.elements) {
        const imported = (entry.propertyName ?? entry.name).text;
        if (globalHooks.has(imported)) violations.push(`${relative(root, file)}: migrated UI imports global ${imported}; use its declared consumer`);
      }
    }
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword
      && node.arguments.some(argument => ts.isStringLiteral(argument) && globalModule(argument.text))) {
      violations.push(`${relative(root, file)}: dynamic global module access bypasses consumer UI imports`);
    }
    const moduleExpression = ts.isExportDeclaration(node) ? node.moduleSpecifier
      : ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference) ? node.moduleReference.expression
      : ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "require" ? node.arguments[0] : undefined;
    if (moduleExpression && ts.isStringLiteral(moduleExpression) && globalModule(moduleExpression.text)) {
      violations.push(`${relative(root, file)}: indirect runtime module access bypasses consumer UI imports`);
    }
    ts.forEachChild(node, scan);
  }
  scan(source);
}

if (violations.length) {
  console.error("React resource boundary violations:");
  for (const violation of [...new Set(violations)]) console.error(`- ${violation}`);
  process.exit(1);
}
console.log("React resource boundaries are clean.");
