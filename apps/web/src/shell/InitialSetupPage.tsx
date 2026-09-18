// apps/web/src/shell/InitialSetupPage.tsx
// 首次 Storage 初始化的整页 onboarding 壳。
//
// 业务状态机与 UI 已收敛到 @keymaster/platform-storage 的 BucketSetupWizard
// （与桶管理页的"新建桶"Modal 共用同一模块）。本文件只负责：
//   - 套上 OnboardingShell（首启视觉）；
//   - 提交成功后进入 home。
//
// 不变量由共享模块保证：只读探测、读取失败不当作空桶、Key 有独立密码、
// 不在页面上回显 Endpoint / 凭据 / 密码 / 私钥材料。

import { router } from "@keymaster/runtime";
import { BucketSetupWizard } from "@keymaster/platform-storage";
import { OnboardingShell } from "./OnboardingShell.js";

export function InitialSetupPage() {
  return (
    <OnboardingShell width="wizard">
      <BucketSetupWizard variant="page" onDone={() => router.push("/")} />
    </OnboardingShell>
  );
}
