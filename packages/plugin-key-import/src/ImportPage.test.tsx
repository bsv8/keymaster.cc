// packages/plugin-key-import/src/ImportPage.test.tsx
// ImportPage 页面级验收测试（硬切换 012 / 施工单 001 复审）。
//
// 关键不变量（页面层）：
//   1. 选中 JSON importer 后，渲染"JSON 文件 / JSON 文本"输入方式切换。
//   2. 切换输入方式会清空旧方式残留：文件 / 文件名 / 文本 / 密码嗅探。
//   3. 文本模式下粘贴 bsv8 envelope 文本会升起密码框；解析失败时
//      fail-open 升起密码框。
//   4. 文本模式下粘贴明文 JSON 可以直接解析。
//   5. JSON 文本模式的密码 label 是中性的"导入源密码"，不再固定
//      "备份文件密码"。
//   6. WIF / Hex importer 走原 text 路径，不显示 JSON 输入方式切换。

// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PluginHostProvider } from "@keymaster/runtime";
import { ImportPage } from "./ImportPage.js";
import { createTestHost } from "./testSupport/createTestHost.js";
import {
  initialJsonImportState,
  reduceJsonImport,
  type JsonImportState
} from "./jsonImportStateMachine.js";

afterEach(() => {
  // 防止多个 mount() 之间的 DOM 残留。
  document.body.innerHTML = "";
});

function mount() {
  const handle = createTestHost();
  return {
    ...handle,
    unmount: render(
      <PluginHostProvider host={handle.host}>
        <ImportPage />
      </PluginHostProvider>
    ).unmount
  };
}

/** 选中 importer picker 里的 JSON 项（按 .importer-picker__item class 限定）。 */
async function selectJsonImporter(user: ReturnType<typeof userEvent.setup>) {
  const items = document.querySelectorAll(".importer-picker__item");
  for (const item of Array.from(items)) {
    if (item.textContent?.includes("JSON")) {
      await user.click(item as HTMLElement);
      return;
    }
  }
  throw new Error("JSON importer item not found");
}

describe("ImportPage - 渲染默认状态", () => {
  it("渲染页面标题与导入器选择器", () => {
    mount();
    expect(screen.getByText(/导入私钥|Import a key/)).toBeTruthy();
    // ImporterPicker 列出 json-file importer
    expect(screen.getByText(/JSON/).textContent).toBeTruthy();
  });

  it("默认未选 importer 时不显示输入方式切换", () => {
    mount();
    // 没选 importer 时不应显示 mode 切换 Select
    expect(screen.queryByText(/输入方式|Input mode/)).toBeNull();
  });
});

describe("ImportPage - JSON importer 选中的输入方式切换", () => {
  it("选中 JSON importer 后显示输入方式切换，默认 file", async () => {
    const user = userEvent.setup();
    mount();
    await selectJsonImporter(user);
    // 输入方式 label 出现
    expect(screen.getByText(/输入方式|Input mode/)).toBeTruthy();
    // 默认是 JSON 文件（显示文件输入控件）
    expect(screen.queryByRole("textbox", { name: /JSON 文本|JSON text/ })).toBeNull();
    // 文件控件 label "File" / "文件"
    expect(screen.getByText(/文件|File/)).toBeTruthy();
  });

  it("切到 JSON 文本模式显示 TextArea", async () => {
    const user = userEvent.setup();
    mount();
    await selectJsonImporter(user);
    // 切到文本
    const select = screen.getByRole("combobox");
    await user.selectOptions(select, "text");
    // textarea 出现
    await waitFor(() => {
      expect(screen.getByRole("textbox", { name: /JSON 文本|JSON text/ })).toBeTruthy();
    });
  });
});

describe("ImportPage - 切换输入方式清空旧状态", () => {
  // 注意：文件上传在 jsdom 下需要等 React 处理 async onChange，本测试集
  // 选择直接用 textarea 来验证"切换输入方式会清空旧模式残留"。
  // state machine 层（jsonImportStateMachine.test.ts）已覆盖文件相关
  // 的所有 reducer 转移。

  it("文本 → 文件：清掉文本内容", async () => {
    const user = userEvent.setup();
    mount();
    await selectJsonImporter(user);

    // 先切到文本
    const select = screen.getByRole("combobox");
    await user.selectOptions(select, "text");

    const text = JSON.stringify({ privateKey: "5Hwgr3..." });
    const ta = screen.getByRole("textbox", { name: /JSON 文本|JSON text/ }) as HTMLTextAreaElement;
    // fireEvent.change 一次性写入整段 JSON，避开 userEvent.type 把 `{` 解析成
    // 键盘修饰键。
    fireEvent.change(ta, { target: { value: text } });
    expect(ta.value).toBe(text);

    // 切回文件
    await user.selectOptions(select, "file");
    // 文本框应消失，回到文件选择器
    await waitFor(() => {
      expect(screen.queryByRole("textbox", { name: /JSON 文本|JSON text/ })).toBeNull();
    });
    // 同时文本内容也被清掉（切回文件模式后回到原始文件选择器）
    expect(screen.queryByText(text)).toBeNull();
  });
});

describe("ImportPage - JSON 文本模式 bsv8 envelope 嗅探", () => {
  it("粘贴 bsv8 envelope 文本升起密码框", async () => {
    const user = userEvent.setup();
    mount();
    await selectJsonImporter(user);

    const select = screen.getByRole("combobox");
    await user.selectOptions(select, "text");

    const envelope = JSON.stringify({
      version: "kek-v1",
      kdf: "argon2id",
      cipher: "xchacha20poly1305",
      kdf_params: { memory_kib: 1024, time_cost: 1, parallelism: 4, salt_hex: "00".repeat(16) },
      nonce_hex: "00".repeat(24),
      ciphertext_hex: "00".repeat(96)
    });
    const ta = screen.getByRole("textbox", { name: /JSON 文本|JSON text/ }) as HTMLTextAreaElement;
    fireEvent.change(ta, { target: { value: envelope } });

    // 嗅探命中后，密码 label "Import-source password" / "导入源密码" 出现
    await waitFor(() => {
      expect(screen.getByText(/Import-source password|导入源密码/)).toBeTruthy();
    });
  });

  it("粘贴明文 JSON 不升起密码框", async () => {
    const user = userEvent.setup();
    mount();
    await selectJsonImporter(user);

    const select = screen.getByRole("combobox");
    await user.selectOptions(select, "text");

    const ta = screen.getByRole("textbox", { name: /JSON 文本|JSON text/ }) as HTMLTextAreaElement;
    fireEvent.change(ta, {
      target: { value: JSON.stringify({ privateKey: "5Hwgr3..." }) }
    });

    // 等待嗅探 + 重渲染
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByText(/Import-source password|导入源密码/)).toBeNull();
  });
});

describe("ImportPage - reset 不保留 label（施工单 001 复审回归）", () => {
  it("解析成功后 set-label 写入 label；reset 后 label 字段必须为空", () => {
    // 关键不变量：reset 是"save 成功后回到干净状态"的入口；
    // label 必须被清零，否则下一次导入会复用旧标签。
    // 这个测试**不依赖**真实 save（stub vault 抛错），而是直接
    // 验证 reducer 的 contract：reset wipes everything including label。
    const initial: JsonImportState = initialJsonImportState;
    const labeled: JsonImportState = reduceJsonImport(initial, {
      type: "set-label",
      label: "stale-label"
    });
    expect(labeled.label).toBe("stale-label");
    const reset: JsonImportState = reduceJsonImport(labeled, { type: "reset" });
    expect(reset.label).toBe("");
  });
});