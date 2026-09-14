import { defineConfig } from "vitepress";
import typedocSidebar from "../api/typedoc-sidebar.json";

function normalizeBasePath(input: string | undefined): string {
  const value = input?.trim().replace(/^\/+|\/+$/g, "") ?? "";
  if (!value) return "/";
  return `/${value}/`;
}

const base = normalizeBasePath(process.env.DOCS_BASE);
const repositoryUrl = process.env.DOCS_REPOSITORY_URL?.trim().replace(/\/+$/, "") ?? "";
const repositoryBranch = process.env.DOCS_REPOSITORY_BRANCH?.trim() || "main";
const sourceUrl = repositoryUrl
  ? `${repositoryUrl}/tree/${encodeURIComponent(repositoryBranch)}/packages/connect`
  : "";

export default defineConfig({
  lang: "zh-CN",
  title: "Keymaster Connect",
  description: "面向浏览器 App 的类型安全身份、密码学、消息、存储和支付能力。",
  base,
  appearance: "dark",
  cleanUrls: true,
  lastUpdated: true,
  head: [
    ["meta", { name: "theme-color", content: "#07110f" }],
    ["meta", { property: "og:type", content: "website" }],
    ["meta", { property: "og:title", content: "Keymaster Connect SDK" }],
    ["meta", { property: "og:description", content: "浏览器 App 请求能力，但永远不接触私钥。" }]
  ],
  themeConfig: {
    logo: { src: "/keymaster-mark.svg", alt: "Keymaster Connect" },
    siteTitle: "Connect",
    nav: [
      { text: "指南", link: "/guide/getting-started" },
      { text: "概念", link: "/concepts/sessions" },
      { text: "API", link: "/api/" },
      { text: "v0.1.0", items: [{ text: "发布说明", link: "/release-notes" }] }
    ],
    sidebar: {
      "/guide/": [
        {
          text: "指南",
          items: [
            { text: "快速开始", link: "/guide/getting-started" },
            { text: "调用能力", link: "/guide/capabilities" },
            { text: "接收事件", link: "/guide/events" },
            { text: "错误与取消", link: "/guide/errors" }
          ]
        }
      ],
      "/concepts/": [
        {
          text: "概念",
          items: [
            { text: "会话", link: "/concepts/sessions" },
            { text: "Popup 模式", link: "/concepts/popup-mode" },
            { text: "appView mode", link: "/concepts/appview-mode" },
            { text: "二进制数据", link: "/concepts/binary-data" },
            { text: "安全模型", link: "/concepts/security" }
          ]
        }
      ],
      "/api/": [
        {
          text: "API 字段参考",
          items: typedocSidebar
        }
      ]
    },
    search: {
      provider: "local",
      options: {
        detailedView: true
      }
    },
    socialLinks: repositoryUrl ? [{ icon: "github", link: repositoryUrl }] : [],
    ...(repositoryUrl ? {
      editLink: {
        pattern: `${repositoryUrl}/edit/${encodeURIComponent(repositoryBranch)}/apps/connect-docs/site/:path`,
        text: "在 GitHub 编辑此页"
      }
    } : {}),
    outline: { level: [2, 3], label: "本页内容" },
    docFooter: { prev: "上一页", next: "下一页" },
    footer: {
      message: "使用能力，不托管私钥。",
      copyright: "Keymaster Connect"
    }
  },
  vite: {
    define: {
      __CONNECT_SOURCE_URL__: JSON.stringify(sourceUrl)
    }
  }
});
