// Coordinator 不可逆 I/O 静态门禁。
//
// 这里不试图从业务名称推断“这次 fetch 是否有副作用”；它只检查更
// 基础、可执行的约束：生产 Coordinator 的每个 final-I/O lease 调用都
// 必须填写审计入口，且所有真实后台任务都必须绑定审计入口。未知结果
// 仍由运行时审计与领域仓库处理，不能由本脚本自动判定成功。

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const workerPath = resolve("apps/web/src/keymasterSessionCoordinator.worker.ts");
const auditPath = resolve("apps/web/src/coordinator/finalIoAudit.ts");
const workerUnitCatalogPath = resolve("apps/web/src/coordinator/workerUnitCatalog.ts");
const workerSource = await readFile(workerPath, "utf8");
const auditSource = await readFile(auditPath, "utf8");
const workerUnitCatalogSource = await readFile(workerUnitCatalogPath, "utf8");
const violations = [];

function lineAt(source, index) {
  return source.slice(0, index).split("\n").length;
}

function matchingCall(source, openIndex) {
  let depth = 1;
  let quote = null;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let index = openIndex + 1; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];
    if (lineComment) {
      if (char === "\n") lineComment = false;
      continue;
    }
    if (blockComment) {
      if (char === "*" && next === "/") {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === "/" && next === "/") {
      lineComment = true;
      index += 1;
      continue;
    }
    if (char === "/" && next === "*") {
      blockComment = true;
      index += 1;
      continue;
    }
    if (char === "\"" || char === "'" || char === "`") {
      quote = char;
      continue;
    }
    if (char === "(") depth += 1;
    if (char === ")") {
      depth -= 1;
      if (depth === 0) return source.slice(openIndex + 1, index);
    }
  }
  return null;
}

function checkFinalIoLeaseCalls() {
  const token = "withCoordinatorFinalIoLease";
  let from = 0;
  while (true) {
    const tokenIndex = workerSource.indexOf(token, from);
    if (tokenIndex < 0) return;
    let openIndex = tokenIndex + token.length;
    while (/\s/u.test(workerSource[openIndex] ?? "")) openIndex += 1;
    // 跳过泛型函数定义 `withCoordinatorFinalIoLease<T>(...)`；生产调用
    // 必须是普通函数调用，不能靠泛型定义本身满足审计要求。
    if (workerSource[openIndex] === "<") {
      from = openIndex + 1;
      continue;
    }
    if (workerSource[openIndex] !== "(") {
      from = openIndex + 1;
      continue;
    }
    const body = matchingCall(workerSource, openIndex);
    if (body === null) {
      violations.push(`worker:${lineAt(workerSource, tokenIndex)} final-I/O lease 调用括号不完整`);
      return;
    }
    if (!(/\bauditOperation\s*:/u.test(body) || /\{\s*auditOperation\s*\}/u.test(body))) {
      violations.push(`worker:${lineAt(workerSource, tokenIndex)} final-I/O lease 调用缺少 auditOperation（审计入口）`);
    }
    from = openIndex + body.length + 2;
  }
}

checkFinalIoLeaseCalls();

const productionTaskAuditEntries = [
  ["contacts.presence-probe", "contacts.presence-probe"],
  ["p2pkh.transactions-sync", "p2pkh.sync"],
  ["p2pkh.utxo-snapshot", "p2pkh.utxo-snapshot"],
  ["token-bsv21.sync", "token-bsv21.sync"],
  ["token-stas.sync", "token-stas.sync"],
  ["collectible-1satordinals.sync", "collectible-1satordinals.sync"],
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
