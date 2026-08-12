import { defineConfig } from "vitepress";
import typedocSidebar from "../api/typedoc-sidebar.json";

export default defineConfig({
  lang: "en-US",
  title: "Keymaster Connect",
  description: "Type-safe browser capabilities for identity, cryptography, messaging, storage, and payments.",
  appearance: "dark",
  cleanUrls: true,
  lastUpdated: true,
  head: [
    ["meta", { name: "theme-color", content: "#07110f" }],
    ["meta", { property: "og:type", content: "website" }],
    ["meta", { property: "og:title", content: "Keymaster Connect SDK" }],
    ["meta", { property: "og:description", content: "Build browser apps that ask for capabilities, never private keys." }]
  ],
  themeConfig: {
    logo: { src: "/keymaster-mark.svg", alt: "Keymaster Connect" },
    siteTitle: "Connect",
    nav: [
      { text: "Guide", link: "/guide/getting-started" },
      { text: "Concepts", link: "/concepts/sessions" },
      { text: "API", link: "/api/" },
      { text: "v0.1.0", items: [{ text: "Release notes", link: "/release-notes" }] }
    ],
    sidebar: {
      "/guide/": [
        {
          text: "Guide",
          items: [
            { text: "Getting started", link: "/guide/getting-started" },
            { text: "Call capabilities", link: "/guide/capabilities" },
            { text: "Handle events", link: "/guide/events" },
            { text: "Errors & cancellation", link: "/guide/errors" }
          ]
        }
      ],
      "/concepts/": [
        {
          text: "Concepts",
          items: [
            { text: "Sessions", link: "/concepts/sessions" },
            { text: "Direct popup mode", link: "/concepts/popup-mode" },
            { text: "appView mode", link: "/concepts/appview-mode" },
            { text: "Binary data", link: "/concepts/binary-data" },
            { text: "Security model", link: "/concepts/security" }
          ]
        }
      ],
      "/api/": [
        {
          text: "API Reference",
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
    socialLinks: [
      { icon: "github", link: "https://github.com/bsv8/keymaster.cc" }
    ],
    editLink: {
      pattern: "https://github.com/bsv8/keymaster.cc/edit/main/apps/connect-docs/site/:path",
      text: "Edit this page on GitHub"
    },
    outline: { level: [2, 3], label: "On this page" },
    docFooter: { prev: "Previous", next: "Next" },
    footer: {
      message: "Capability access without key custody.",
      copyright: "Keymaster Connect"
    }
  }
});
