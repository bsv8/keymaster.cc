import react from "@vitejs/plugin-react";
import { execFileSync } from "node:child_process";
import { defineConfig } from "vite";

function readGit(args: string[], fallback: string): string {
  try {
    return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || fallback;
  } catch {
    return fallback;
  }
}

function githubCommitUrl(remote: string, revision: string): string {
  const match = remote.match(/(?:github\.com[/:])([^/]+\/[^/.]+)(?:\.git)?$/);
  return match && revision !== "unknown" ? `https://github.com/${match[1]}/commit/${revision}` : "";
}

function normalizeBranch(value: string): string {
  return value.trim().replace(/^refs\/heads\//, "").replace(/^origin\//, "");
}

function readGitBranch(): string {
  const ciBranch = process.env.GITHUB_HEAD_REF || process.env.GITHUB_REF_NAME || process.env.VERCEL_GIT_COMMIT_REF || process.env.CI_COMMIT_REF_NAME;
  if (ciBranch) return normalizeBranch(ciBranch);

  const checkedOutBranch = normalizeBranch(readGit(["branch", "--show-current"], ""));
  if (checkedOutBranch) return checkedOutBranch;

  // CI 常以 detached HEAD 构建；依次尝试 origin 默认分支与包含当前提交的远端分支。
  const originHead = normalizeBranch(readGit(["symbolic-ref", "--short", "-q", "refs/remotes/origin/HEAD"], ""));
  if (originHead) return originHead;
  const containingBranch = readGit(["branch", "-r", "--contains", "HEAD"], "")
    .split("\n")
    .map((branch) => normalizeBranch(branch.replace(/^\*\s*/, "")))
    .find(Boolean);
  return containingBranch || "main";
}

const gitBranch = readGitBranch();
const gitRevision = readGit(["rev-parse", "--short", "HEAD"], "unknown");
const gitRevisionFull = readGit(["rev-parse", "HEAD"], "unknown");
const gitRemote = readGit(["remote", "get-url", "origin"], "");

export default defineConfig({
  // 应用使用 history 路由。资源必须从站点根路径加载；相对 URL 会在
  // `/settings/system-status` 等深层路由被解析为 `/settings/_static/*`。
  base: "/",
  plugins: [react()],
  define: {
    __KEYMASTER_GIT_BRANCH__: JSON.stringify(gitBranch),
    __KEYMASTER_GIT_REVISION__: JSON.stringify(gitRevision),
    __KEYMASTER_GIT_COMMIT_URL__: JSON.stringify(githubCommitUrl(gitRemote, gitRevisionFull))
  },
  build: {
    // 设计缘由：
    //   - 应用本身已经占用了业务路由 `/assets`（plugin-assets）。
    //   - Vite 默认把构建产物发到 `/assets/*`，部署到 Cloudflare Pages 时，
    //     这会让"业务路由前缀"与"静态资源前缀"同名，排障与规则配置都别扭。
    //   - 改成独立静态前缀后，Pages 上的资源路径会是 `/_static/*`，
    //     与应用路由彻底解耦。
    assetsDir: "_static",
    // 设计缘由：当前首包稳定略高于 Vite 默认 500 kB，项目初期先以降低构建噪音为主，
    // 暂不引入额外分包策略；保留一个略高于现状的阈值，避免无效告警。
    chunkSizeWarningLimit: 1024
  },
  worker: {
    format: "es"
  },
  server: {
    // 只监听本机地址，外部访问统一通过 Tailscale HTTPS 转发到 localhost。
    host: "127.0.0.1",
    // 允许所有主机访问 dev server（避免需要逐个添加域名到白名单）。
    allowedHosts: true
  },
  resolve: {
    alias: {
      // `keymaster-multisig-pool` 当前发布包直接 import Node `crypto`。
      // 浏览器构建只补它实际用到的 `createHmac` 最小能力，不引入整套 polyfill。
      // 用通用全局 URL 取绝对路径，避免依赖 node:url（本项目不引入 node 类型）。
      crypto: new URL("./src/shims/crypto.ts", import.meta.url).pathname
    },
    // 让 Vite 直接消费 packages/* 源码（与 tsc 行为一致）。
    preserveSymlinks: false
  },
  optimizeDeps: {
    include: [
      "@noble/hashes/ripemd160",
      "@noble/hashes/sha256",
      "@noble/hashes/argon2",
      "@noble/ciphers/chacha.js",
      "@noble/secp256k1"
    ]
  }
});
