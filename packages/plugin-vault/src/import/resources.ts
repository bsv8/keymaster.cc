import type { I18nPluginResources } from "@keymaster/contracts";
export const keyImportResources: I18nPluginResources = {
  namespace: "vault",
  resources: {
    en: {
      "vault.import.route.title": "Import a key",
      "vault.import.menu.title": "Import",
      "vault.import.crumb.wallet": "Wallets",
      "vault.import.crumb.title": "Import a key",
      "vault.import.page.title": "Import a key",
      "vault.import.page.desc": "Pick an import format. Vault validates the key and stores it encrypted in this browser.",
      "vault.import.page.step.picker": "1. Pick an import format",
      "vault.import.page.step.input": "2. Input",
      "vault.import.page.step.confirm": "3. Confirm and import",
      "vault.import.page.label.text": "Text",
      "vault.import.page.placeholder.text": "Paste WIF or hex private key",
      "vault.import.page.label.file": "File",
      "vault.import.page.label.password": "Backup file password",
      "vault.import.page.placeholder.password": "Password for the encrypted JSON file",
      // 硬切换 012 验收修复（施工单 001 复审）：密码 label 在文件 / 文本
      // 两种输入方式下都用中性"Import-source password"；不再写死"file"。
      "vault.import.page.label.importPassword": "Import-source password",
      "vault.import.page.placeholder.importPassword": "Password for the encrypted JSON",
      "vault.import.page.action.clear": "Clear",
      "vault.import.page.action.parse": "Parse",
      "vault.import.page.action.save": "Save to Vault",
      "vault.import.page.empty.title": "Waiting for parse",
      "vault.import.page.empty.desc": "After a successful parse, derived address and confirm button appear here.",
      "vault.import.page.detected": "Detected: ",
      "vault.import.page.derived": "Derived address: ",
      "vault.import.page.derivedPending": "Waiting for plugin to backfill",
      "vault.import.page.label.label": "Label",
      "vault.import.page.placeholder.label": "e.g. main wallet / cold wallet",
      "vault.import.page.err.noImporter": "Pick an import format first",
      "vault.import.page.err.noKey": "No private key parsed",
      "vault.import.page.err.parse": "Parse failed",
      "vault.import.page.err.save": "Save failed",
      "vault.import.page.err.noFile": "Please pick a file first",
      // 硬切换 012（施工单 001）：JSON importer 的输入方式切换。
      "vault.import.page.label.inputMode": "Input mode",
      "vault.import.page.option.jsonFile": "JSON file",
      "vault.import.page.option.jsonText": "JSON text",
      "vault.import.page.label.jsonText": "JSON text",
      "vault.import.page.placeholder.jsonText":
        "Paste the JSON content exported from your wallet",
      "vault.import.page.hint.jsonText":
        "Switching input mode clears the current file/text content, password draft, and parsed result.",
      "vault.import.page.filePicked": "Selected: ",
      "vault.import.picker.empty": "No import formats available.",
      "vault.import.page.label.supports": "Supports: ",
      // 硬切换 010：/import 页面在 vault 未解锁时展示的引导文案，提示
      // 用户先去 LockedShell 走首启导入向导或先解锁 Vault。
      "vault.import.page.lockedHint":
        "This page is for importing more keys into an unlocked wallet. Unlock the Vault first, or return to the welcome page to use the first-time import wizard for the first key."
    },
    "zh-CN": {
      "vault.import.route.title": "导入私钥",
      "vault.import.menu.title": "导入",
      "vault.import.crumb.wallet": "钱包",
      "vault.import.crumb.title": "导入私钥",
      "vault.import.page.title": "导入私钥",
      "vault.import.page.desc": "选择导入方式；Vault 校验私钥并在本机浏览器加密保存。",
      "vault.import.page.step.picker": "1. 选择导入方式",
      "vault.import.page.step.input": "2. 输入",
      "vault.import.page.step.confirm": "3. 确认导入",
      "vault.import.page.label.text": "文本",
      "vault.import.page.placeholder.text": "粘贴 WIF 或 hex 私钥",
      "vault.import.page.label.file": "文件",
      "vault.import.page.label.password": "备份文件密码",
      "vault.import.page.placeholder.password": "加密 JSON 文件的密码",
      // 硬切换 012 验收修复（施工单 001 复审）：密码 label 在文件 / 文本
      // 两种输入方式下都用中性"导入源密码"；不再写死"文件"。
      "vault.import.page.label.importPassword": "导入源密码",
      "vault.import.page.placeholder.importPassword": "加密 JSON 的密码",
      "vault.import.page.action.clear": "清除",
      "vault.import.page.action.parse": "解析",
      "vault.import.page.action.save": "保存到 Vault",
      "vault.import.page.empty.title": "等待解析",
      "vault.import.page.empty.desc": "解析成功后这里会显示派生地址和确认按钮。",
      "vault.import.page.detected": "检测到：",
      "vault.import.page.derived": "派生地址：",
      "vault.import.page.derivedPending": "等待业务插件回填",
      "vault.import.page.label.label": "标签",
      "vault.import.page.placeholder.label": "例如 主钱包 / 冷钱包",
      "vault.import.page.err.noImporter": "请先选择导入方式",
      "vault.import.page.err.noKey": "未解析出私钥",
      "vault.import.page.err.parse": "解析失败",
      "vault.import.page.err.save": "保存失败",
      "vault.import.page.err.noFile": "请先选择文件",
      // 硬切换 012（施工单 001）：JSON importer 的输入方式切换。
      "vault.import.page.label.inputMode": "输入方式",
      "vault.import.page.option.jsonFile": "JSON 文件",
      "vault.import.page.option.jsonText": "JSON 文本",
      "vault.import.page.label.jsonText": "JSON 文本",
      "vault.import.page.placeholder.jsonText": "粘贴从钱包导出的 JSON 内容",
      "vault.import.page.hint.jsonText":
        "切换输入方式会清空当前文件 / 文本内容、密码草稿与解析结果。",
      "vault.import.page.filePicked": "已选择：",
      "vault.import.picker.empty": "没有可用的导入器。",
      "vault.import.page.label.supports": "支持：",
      "vault.import.page.lockedHint":
        "此页面仅用于在已解锁的钱包中导入更多 key。请先解锁 Vault，或返回欢迎页通过首启导入向导新建钱包并导入第一把 key。"
    }
  }
};
export const hexResources: I18nPluginResources = {
  namespace: "vault",
  resources: {
    en: {
      "vault.importerHex.name": "Hex",
      "vault.importerHex.description": "32-byte hex private key.",
      "vault.importerHex.summary": "32-byte hex private key"
    },
    "zh-CN": {
      "vault.importerHex.name": "Hex",
      "vault.importerHex.description": "32 字节十六进制私钥。",
      "vault.importerHex.summary": "32 字节十六进制私钥"
    }
  }
};
export const wifResources: I18nPluginResources = {
  namespace: "vault",
  resources: {
    en: {
      "vault.importerWif.name": "WIF",
      "vault.importerWif.description": "Paste a BSV WIF private key (Base58Check encoded).",
      "vault.importerWif.summary.compressed": "Compressed WIF",
      "vault.importerWif.summary.uncompressed": "Uncompressed WIF"
    },
    "zh-CN": {
      "vault.importerWif.name": "WIF",
      "vault.importerWif.description": "粘贴 BSV WIF 私钥（Base58Check 编码）。",
      "vault.importerWif.summary.compressed": "Compressed WIF",
      "vault.importerWif.summary.uncompressed": "Uncompressed WIF"
    }
  }
};
export const jsonFileResources: I18nPluginResources = {
  namespace: "vault",
  resources: {
    en: {
      "vault.importerJsonFile.name": "JSON",
      "vault.importerJsonFile.description":
        "Extract private keys from a wallet JSON export; supports JSON files, JSON text, and bsv8 encrypted envelopes.",
      "vault.importerJsonFile.summary.envelope": "bsv8 encrypted key envelope",
      "vault.importerJsonFile.summary.field": "Field: {{path}}"
    },
    "zh-CN": {
      "vault.importerJsonFile.name": "JSON",
      "vault.importerJsonFile.description":
        "从钱包导出的 JSON 中提取私钥；支持 JSON 文件、JSON 文本与 bsv8 加密 envelope。",
      "vault.importerJsonFile.summary.envelope": "bsv8 加密 envelope",
      "vault.importerJsonFile.summary.field": "字段：{{path}}"
    }
  }
};