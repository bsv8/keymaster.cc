import { createHash } from "node:crypto";
import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { extname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

/**
 * Static capability inventory for the Keymaster contract package.
 *
 * This scanner intentionally reads source only. It never imports a contract,
 * executes a parser, or serializes Function#toString. The same identity and
 * source-fingerprint gate is used for the six Coordinator RPC/stream
 * capabilities and every other production capability under packages/contracts.
 */

const execFileAsync = promisify(execFile);
const defaultRoot = fileURLToPath(new URL("..", import.meta.url));
const argv = process.argv.slice(2);
const flags = new Set(argv);
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
const inventoryPath = resolve(root, optionValues("--inventory")[0] ?? "packages/contracts/contract-inventory.json");
const baselineRefValues = optionValues("--baseline-ref");
if (baselineRefValues.length > 1 || (flags.has("--baseline-ref") && baselineRefValues.length === 0)) {
  throw new Error("--baseline-ref requires exactly one Git ref");
}
const baselineRef = baselineRefValues[0] ?? "HEAD";
const hasExplicitBaselineRef = baselineRefValues.length === 1;
const fileContents = new Map();

function rel(path) {
  return relative(root, path).split(sep).join("/");
}

function identityKey(entry) {
  return `${entry.kind}\u0000${entry.id}\u0000${entry.version}`;
}

function hashSource(source) {
  return createHash("sha256").update(source, "utf8").digest("hex");
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
    else if (sourcePattern.test(entry.name)) files.push(path);
  }
  return files;
}

async function filesAt(path) {
  try {
    const information = await stat(path);
    if (information.isDirectory()) return filesUnder(path);
    return sourcePattern.test(path) ? [path] : [];
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

function importsFor(sourceFile) {
  const bindings = new Map();
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !statement.importClause || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const module = statement.moduleSpecifier.text;
    const named = statement.importClause.namedBindings;
    if (named && ts.isNamedImports(named)) {
      for (const element of named.elements) {
        bindings.set(element.name.text, { module, imported: element.propertyName?.text ?? element.name.text });
      }
    }
    if (named && ts.isNamespaceImport(named)) bindings.set(named.name.text, { module, imported: "*" });
    if (statement.importClause.name) bindings.set(statement.importClause.name.text, { module, imported: "default" });
  }
  return bindings;
}

function staticImports(sourceFile) {
  return sourceFile.statements.flatMap((statement) => {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) return [statement.moduleSpecifier.text];
    if (ts.isExportDeclaration(statement) && statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)) return [statement.moduleSpecifier.text];
    return [];
  });
}

function resolveLocalImport(fromFile, specifier, knownFiles) {
  if (!specifier.startsWith(".")) return undefined;
  const clean = specifier.split(/[?#]/u, 1)[0];
  const raw = resolve(fromFile, "..", clean);
  const base = /\.(?:[cm]?js|jsx)$/u.test(raw) ? raw.replace(/\.(?:[cm]?js|jsx)$/u, "") : raw;
  const candidates = [];
  if (sourcePattern.test(base)) candidates.push(base);
  else for (const extension of [".ts", ".tsx"]) candidates.push(`${base}${extension}`);
  for (const extension of [".ts", ".tsx"]) candidates.push(resolve(base, `index${extension}`));
  return candidates.find((candidate) => knownFiles.has(candidate));
}

function parserRole(expression, sourceFile, bindings, knownFiles) {
  if (!expression) return undefined;
  let module;
  if (ts.isIdentifier(expression)) module = bindings.get(expression.text)?.module;
  else if (ts.isPropertyAccessExpression(expression) && ts.isIdentifier(expression.expression)) module = bindings.get(expression.expression.text)?.module;
  const resolved = module ? resolveLocalImport(sourceFile.fileName, module, knownFiles) : sourceFile.fileName;
  return {
    expression: sourceFile.text.slice(expression.getStart(sourceFile), expression.end),
    module: rel(resolved ?? sourceFile.fileName),
  };
}

function isDefineCapability(call, bindings) {
  return ts.isIdentifier(call.expression)
    && (call.expression.text === "defineCapability" || bindings.get(call.expression.text)?.imported === "defineCapability");
}

function scan(sourceFiles, knownFiles) {
  const errors = [];
  const entries = [];
  const sourceMap = new Map();
  for (const path of sourceFiles) {
    const source = ts.createSourceFile(path, fileContents.get(path), ts.ScriptTarget.Latest, true, path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    sourceMap.set(path, source);
  }
  for (const sourceFile of sourceMap.values()) {
    const bindings = importsFor(sourceFile);
    const visit = (node) => {
      if (ts.isCallExpression(node) && isDefineCapability(node, bindings)) {
        const argument = node.arguments[0];
        if (!argument || !ts.isObjectLiteralExpression(argument)) {
          errors.push(`${rel(sourceFile.fileName)} defineCapability must receive a static object literal`);
        } else {
          const kind = literalText(propertyExpression(argument, "kind"));
          const id = literalText(propertyExpression(argument, "id"));
          const version = literalText(propertyExpression(argument, "version"));
          if (!kind || !id || !version) {
            errors.push(`${rel(sourceFile.fileName)} capability kind/id/version must be string literals`);
          } else if (!["local", "rpc", "stream"].includes(kind)) {
            errors.push(`${rel(sourceFile.fileName)} capability kind ${JSON.stringify(kind)} is invalid`);
          } else {
            const parser = {};
            const transfer = {};
            const fields = kind === "rpc" ? ["request", "response"] : kind === "stream" ? ["request", "item"] : [];
            for (const field of fields) {
              const role = parserRole(propertyExpression(argument, field), sourceFile, bindings, knownFiles);
              if (!role) errors.push(`${rel(sourceFile.fileName)} ${kind} capability is missing ${field} parser`);
              else parser[field] = role;
            }
            const transferObject = propertyExpression(argument, "transfer");
            for (const field of fields) {
              const role = transferObject && ts.isObjectLiteralExpression(transferObject)
                ? parserRole(propertyExpression(transferObject, field), sourceFile, bindings, knownFiles)
                : undefined;
              if (role) transfer[field] = role;
            }
            entries.push({
              kind,
              id,
              version,
              module: rel(sourceFile.fileName),
              moduleFingerprint: hashSource(fileContents.get(sourceFile.fileName)),
              ...(Object.keys(parser).length > 0 ? { parser } : {}),
              ...(Object.keys(transfer).length > 0 ? { transfer } : {}),
              dependencyFingerprints: [],
            });
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    ts.forEachChild(sourceFile, visit);
  }
  const seen = new Map();
  for (const entry of entries) {
    const key = identityKey(entry);
    if (seen.has(key)) errors.push(`duplicate capability identity ${key.replaceAll("\u0000", "/")} in ${seen.get(key)} and ${entry.module}`);
    else seen.set(key, entry.module);
  }
  return { entries, errors, sourceMap };
}

function addDependencies(entries, sourceMap, knownFiles) {
  for (const entry of entries) {
    const entryPath = resolve(root, entry.module);
    const seen = new Set([entryPath]);
    const queue = [entryPath];
    while (queue.length > 0) {
      const current = queue.shift();
      const sourceFile = sourceMap.get(current);
      if (!sourceFile) continue;
      for (const specifier of staticImports(sourceFile)) {
        const dependency = resolveLocalImport(current, specifier, knownFiles);
        if (!dependency || seen.has(dependency)) continue;
        seen.add(dependency);
        queue.push(dependency);
      }
    }
    entry.dependencyFingerprints = [...seen]
      .filter((path) => path !== entryPath)
      .sort()
      .map((path) => ({ path: rel(path), fingerprint: hashSource(fileContents.get(path)) }));
    for (const role of Object.values(entry.parser ?? {})) {
      if (role && knownFiles.has(resolve(root, role.module))) role.fingerprint = hashSource(fileContents.get(resolve(root, role.module)));
    }
    for (const role of Object.values(entry.transfer ?? {})) {
      if (role && knownFiles.has(resolve(root, role.module))) role.fingerprint = hashSource(fileContents.get(resolve(root, role.module)));
    }
  }
  return entries;
}

function sorted(entries) {
  return [...entries].sort((left, right) => identityKey(left).localeCompare(identityKey(right)));
}

function normalize(entry) {
  return {
    kind: entry.kind,
    id: entry.id,
    version: entry.version,
    module: entry.module,
    moduleFingerprint: entry.moduleFingerprint,
    ...(entry.parser ? { parser: entry.parser } : {}),
    ...(entry.transfer ? { transfer: entry.transfer } : {}),
    dependencyFingerprints: entry.dependencyFingerprints,
    contractTestVersion: entry.contractTestVersion,
    ...(entry.auditEvidence !== undefined ? { auditEvidence: entry.auditEvidence } : {}),
    ...(entry.versionChangeEvidence !== undefined ? { versionChangeEvidence: entry.versionChangeEvidence } : {}),
  };
}

async function readJson(path) {
  try {
    const value = JSON.parse(await readFile(path, "utf8"));
    if (!value || value.schemaVersion !== 1 || !Array.isArray(value.entries)) throw new Error("schemaVersion 1 with entries[] is required");
    return value;
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw new Error(`Cannot read ${rel(path)}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function readBaselineInventory() {
  if (hasExplicitBaselineRef) {
    try {
      await execFileAsync("git", ["rev-parse", "--verify", `${baselineRef}^{commit}`], { cwd: root, maxBuffer: 5 * 1024 * 1024 });
    } catch {
      throw new Error(`Cannot resolve contract inventory baseline ref ${JSON.stringify(baselineRef)}`);
    }
  }
  try {
    const { stdout } = await execFileAsync("git", ["show", `${baselineRef}:${rel(inventoryPath)}`], { cwd: root, maxBuffer: 5 * 1024 * 1024 });
    const value = JSON.parse(stdout);
    return value?.schemaVersion === 1 && Array.isArray(value.entries) ? value : undefined;
  } catch {
    return undefined;
  }
}

function byIdentity(entries) {
  return new Map(entries.map((entry) => [identityKey(entry), entry]));
}

function compare(observed, inventory, headInventory) {
  const errors = [];
  if (!inventory) {
    errors.push(`missing ${rel(inventoryPath)}; run node scripts/check-contract-inventory.mjs --update and review the generated inventory`);
    return errors;
  }
  const current = sorted(inventory.entries).map(normalize);
  const actual = sorted(observed).map(normalize);
  const currentByKey = byIdentity(current);
  const actualByKey = byIdentity(actual);
  for (const key of new Set([...currentByKey.keys(), ...actualByKey.keys()])) {
    if (!currentByKey.has(key)) errors.push(`contract inventory is missing observed identity ${key.replaceAll("\u0000", "/")}`);
    else if (!actualByKey.has(key)) errors.push(`contract inventory contains stale identity ${key.replaceAll("\u0000", "/")}`);
    else if (JSON.stringify(currentByKey.get(key)) !== JSON.stringify(actualByKey.get(key))) errors.push(`contract inventory fingerprint/metadata differs for ${key.replaceAll("\u0000", "/")}`);
  }
  for (const entry of current) {
    const key = identityKey(entry);
    if (typeof entry.contractTestVersion !== "string" || entry.contractTestVersion.trim() === "") errors.push(`contract inventory entry ${key.replaceAll("\u0000", "/")} needs contractTestVersion`);
    if (entry.auditEvidence !== undefined && typeof entry.auditEvidence !== "string") errors.push(`contract inventory entry ${key.replaceAll("\u0000", "/")} auditEvidence must be a string`);
    if (entry.versionChangeEvidence !== undefined && typeof entry.versionChangeEvidence !== "string") errors.push(`contract inventory entry ${key.replaceAll("\u0000", "/")} versionChangeEvidence must be a string`);
  }
  if (headInventory) {
    const oldByKey = byIdentity(headInventory.entries.map(normalize));
    for (const [key, entry] of currentByKey) {
      const old = oldByKey.get(key);
      if (old && JSON.stringify(old) !== JSON.stringify(entry)) {
        const sourceChanged = old.moduleFingerprint !== entry.moduleFingerprint
          || JSON.stringify(old.parser ?? {}) !== JSON.stringify(entry.parser ?? {})
          || JSON.stringify(old.transfer ?? {}) !== JSON.stringify(entry.transfer ?? {})
          || JSON.stringify(old.dependencyFingerprints) !== JSON.stringify(entry.dependencyFingerprints);
        if (sourceChanged && old.version === entry.version && (!entry.auditEvidence?.trim() || entry.contractTestVersion === old.contractTestVersion)) {
          errors.push(`source fingerprints changed for ${key.replaceAll("\u0000", "/")} without a new contractTestVersion and auditEvidence`);
        }
      }
      if (!old) {
        const sameContract = [...oldByKey.values()].find((candidate) => candidate.kind === entry.kind && candidate.id === entry.id);
        if (sameContract && (!entry.versionChangeEvidence?.trim() || entry.contractTestVersion === sameContract.contractTestVersion)) {
          errors.push(`contract version changed for ${entry.kind}/${entry.id} without versionChangeEvidence and a new contractTestVersion`);
        }
      }
    }
  }
  return errors;
}

const files = [...new Set((await Promise.all(sourceRoots.map(filesAt))).flat())]
  .filter((path) => !testPattern.test(path));
for (const path of files) fileContents.set(path, await readFile(path, "utf8"));
const knownFiles = new Set(files);
const scanned = scan(files, knownFiles);
const rawInventory = await readJson(inventoryPath);
const metadata = byIdentity(rawInventory?.entries ?? []);
addDependencies(scanned.entries, scanned.sourceMap, knownFiles);
const observed = scanned.entries.map((entry) => ({
  ...entry,
  contractTestVersion: metadata.get(identityKey(entry))?.contractTestVersion ?? "keymaster-v4-contract-tests.1",
  auditEvidence: metadata.get(identityKey(entry))?.auditEvidence
    ?? "Keymaster v4 production contract inventory generated by the static source scanner and covered by the contract/type gates.",
  ...(metadata.get(identityKey(entry))?.versionChangeEvidence !== undefined
    ? { versionChangeEvidence: metadata.get(identityKey(entry)).versionChangeEvidence }
    : {}),
}));
const generated = { schemaVersion: 1, entries: sorted(observed).map(normalize) };

if (flags.has("--print") || flags.has("--update")) {
  if (scanned.errors.length > 0) {
    console.error(scanned.errors.join("\n"));
    process.exitCode = 1;
  } else if (flags.has("--update")) {
    await writeFile(inventoryPath, `${JSON.stringify(generated, null, 2)}\n`, "utf8");
    console.log(`Wrote ${rel(inventoryPath)} (${generated.entries.length} identities)`);
  } else {
    console.log(JSON.stringify(generated, null, 2));
  }
} else {
  const errors = [...scanned.errors, ...compare(observed, rawInventory, await readBaselineInventory())];
  if (errors.length > 0) {
    console.error(errors.join("\n"));
    process.exitCode = 1;
  } else {
    console.log(`Keymaster contract inventory check passed (${generated.entries.length} identities)`);
  }
}
