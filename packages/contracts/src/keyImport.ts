// Worker 初始化命令的材料 DTO；解析器和导入 UI 只存在于 Vault 内部。
export interface KeyImportMaterial { hex: string; wif?: string; }
