# Storage smoke credentials

This directory is reserved for credentials used by the opt-in real-provider
Storage smoke test. Every local file in this directory is ignored by Git except
this README and the redacted `.env.example` template.

## Configure

```bash
cp .storage-smoke/.env.example .storage-smoke/.env
chmod 600 .storage-smoke/.env
```

Edit `.storage-smoke/.env`, select `aws`, `r2`, `compatible`, or `all`, and fill
the corresponding section. Values already exported in the shell or supplied by
CI override values from this file.

Use a dedicated test bucket and a least-privilege key restricted to object
list/read/write/delete and multipart operations in that bucket. Do not use an
account-management token. The test creates a unique App namespace directly at
the Bucket root and attempts to remove every object it creates in a `finally`
block.

## Run

```bash
pnpm test:storage:smoke
```

The test is deliberately excluded from the normal `pnpm test` command. Never
commit `.storage-smoke/.env`, paste its values into an issue, or pass secrets on
the command line where shell history can retain them. Rotate a key immediately
if it is exposed.
