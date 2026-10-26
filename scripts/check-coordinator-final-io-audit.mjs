// Coordinator 不可逆 I/O 静态门禁。
//
// 这里不试图从业务名称推断“这次 fetch 是否有副作用”；它只检查更
// 基础、可执行的约束：生产 Coordinator 的每个 final-I/O lease 调用都
// 必须填写审计入口，且所有真实后台任务都必须绑定审计入口。未知结果
// 仍由运行时审计与领域仓库处理，不能由本脚本自动判定成功。

import { readFile, readdir } from "node:fs/promises";
import ts from "typescript";
import { resolve, relative } from "node:path";

const workerPath = resolve("src/assembly/coordinatorWorker.ts");
const entryPath = resolve("src/keymasterSessionCoordinator.worker.ts");
const auditPath = resolve("src/coordinator/finalIoAudit.ts");
const workerUnitCatalogPath = resolve("src/coordinator/workerUnitCatalog.ts");
const workerSource = await readFile(workerPath, "utf8");
const auditSource = await readFile(auditPath, "utf8");
const workerUnitCatalogSource = await readFile(workerUnitCatalogPath, "utf8");
const violations = [];

function lineAt(source, index) {
  return source.slice(0, index).split("\n").length;
}

/** 检查真实调用的最后一个参数，不能由回调内别的 auditOperation 蒙混过关。 */
function checkFinalIoLeaseCalls(path, source) {
  const ast = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
  function visit(node) {
    if (ts.isCallExpression(node)) {
      const target = node.expression.getText(ast);
      if (target === "withCoordinatorFinalIoLease" || target === "ports.io.run") {
        const options = node.arguments[3];
        const audit = options && ts.isObjectLiteralExpression(options)
          ? options.properties.find(property => property.name?.getText(ast) === "auditOperation")
          : undefined;
        const location = `${relative(process.cwd(), path)}:${lineAt(source, node.getStart(ast))}`;
        if (!audit) violations.push(`${location} final-I/O 调用缺少显式 auditOperation（审计入口）`);
        else if (ts.isPropertyAssignment(audit) && ts.isStringLiteral(audit.initializer)
          && !auditSource.includes(`| "${audit.initializer.text}"`)) {
          violations.push(`${location} 未登记的审计入口 ${audit.initializer.text}`);
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
}

checkFinalIoLeaseCalls(entryPath, await readFile(entryPath, "utf8"));
checkFinalIoLeaseCalls(workerPath, workerSource);
// 移入插件的领域调用也必须受同一个门禁约束；不能只检查入口中的转发器。
async function checkWorkerModules(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) await checkWorkerModules(path);
    else if (/^worker.*\.ts$/u.test(entry.name) && !/\.test\.ts$/u.test(entry.name)) {
      checkFinalIoLeaseCalls(path, await readFile(path, "utf8"));
    }
  }
}
for (const entry of await readdir(resolve("packages"), { withFileTypes: true })) {
  if (entry.isDirectory()) await checkWorkerModules(resolve("packages", entry.name, "src"));
}

const productionTaskAuditEntries = [
  ["contacts.presence-probe", "contacts.presence-probe"],
  ["p2pkh.transactions-sync", "p2pkh.sync"],
  ["p2pkh.utxo-snapshot", "p2pkh.utxo-snapshot"],
];
for (const [taskId, auditOperation] of productionTaskAuditEntries) {
  const entryPattern = new RegExp(`taskId\\s*:\\s*["']${taskId}["'][\\s\\S]{0,160}operation\\s*:\\s*["']${auditOperation}["']`);
  if (!entryPattern.test(workerUnitCatalogSource)) {
    violations.push(`worker-unit-catalog:任务 ${taskId} 未绑定最终 I/O 审计入口 ${auditOperation}`);
  }
  if (!auditSource.includes(`| "${auditOperation}"`)) {
    violations.push(`audit:${auditOperation} 未登记在 FinalIoAuditOperation 契约`);
  }
}

if (!workerSource.includes("COORDINATOR_WORKER_UNIT_CATALOG.flatMap")) {
  violations.push("worker:最终 I/O 审计映射未从 Worker 单元目录生成");
}
if (!workerSource.includes("const auditOperation = COORDINATOR_TASK_FINAL_IO_AUDIT[taskId]")) {
  violations.push("worker:executeTask 未通过任务审计映射进入最终 I/O 边界");
}

if (violations.length > 0) {
  console.error("Coordinator 不可逆 I/O 审计门禁失败：");
  for (const violation of violations) console.error(`- ${violation}`);
  process.exitCode = 1;
} else {
  console.log("Coordinator 不可逆 I/O 审计门禁通过：final-I/O 调用和真实后台任务均已绑定审计入口。");
}
