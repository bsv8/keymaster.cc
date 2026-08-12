# Keymaster Connect documentation

This is the independently deployable documentation site for
`@keymaster/connect`. Hand-written guides live in `site/`; the API reference is
generated from the SDK's real public entry point at
`packages/connect/src/index.ts`.

```bash
pnpm --filter @keymaster/connect-docs dev
pnpm --filter @keymaster/connect-docs build
pnpm --filter @keymaster/connect-docs preview
```

The production build is emitted to `site/.vitepress/dist`. Deploy that directory
to any static host. `site/api` is generated output and must not be edited or
committed.

The build is origin-independent. For a site deployed below an origin root,
provide its public pathname at build time:

```bash
DOCS_BASE=/connect-docs/ pnpm --filter @keymaster/connect-docs build
```

`DOCS_BASE` defaults to `/`; surrounding slashes are normalized automatically.
Publish the generated `dist` directory at the same path used for the build.

Source and edit links are optional deployment metadata:

```bash
DOCS_REPOSITORY_URL=https://git.example/team/connect \
DOCS_REPOSITORY_BRANCH=main \
pnpm --filter @keymaster/connect-docs build
```

The build deliberately regenerates the API reference before VitePress runs. A
renamed or removed SDK export therefore changes the site in the same build; no
parallel documentation adapter has to be maintained.
