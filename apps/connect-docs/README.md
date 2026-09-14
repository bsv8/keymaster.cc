# Keymaster Connect 文档站

这是 `@keymaster/connect` 的独立文档站。手写说明位于 `site/`；API 页面从
`packages/connect/src/index.ts` 的真实导出和中文类型注释生成，不能手工修改 `site/api`。

```bash
pnpm --filter @keymaster/connect-docs dev
pnpm --filter @keymaster/connect-docs build
pnpm --filter @keymaster/connect-docs preview
```

构建结果位于 `site/.vitepress/dist`。部署在子路径时传入公开路径：

```bash
DOCS_BASE=/connect-docs/ pnpm --filter @keymaster/connect-docs build
```

可选的 `DOCS_REPOSITORY_URL` 和 `DOCS_REPOSITORY_BRANCH` 用于生成源码与编辑链接。
