# 项目结构

这个文档只表达仓库的高层稳定结构，不展开各包内部的 `src/` 细节。

这样做的原因有两个：

- 完整目录树变化太快，图很容易过时。
- 这个仓库的核心是分层和插件边界，不是文件清单。

`docu.md` 可以直接打开本文件并渲染下面的 PlantUML 代码块。

## 高层结构图

```plantuml
@startuml
title Keymaster 项目结构（高层）
left to right direction
skinparam shadowing false
skinparam packageStyle rectangle
skinparam defaultTextAlignment center

folder "仓库根目录" as repo {
  folder "apps" as apps {
    folder "web\nWeb 入口、Shell、插件装配" as app_web
  }

  folder "packages" as packages {
    package "contracts\n跨包协议与 capability 定义" as pkg_contracts
    package "runtime\n插件宿主与内置 registry" as pkg_runtime
    package "ui\n通用 UI 组件" as pkg_ui

    folder "plugin 基础设施层" as pkg_infra {
      package "plugin-woc\n链上查询入口" as plugin_woc
      package "plugin-background\n后台任务平台" as plugin_background
      package "plugin-protocol\n协议入口与弹窗流程" as plugin_protocol
      package "plugin-hubmsg\nHub 消息接入" as plugin_hubmsg
      package "plugin-webrtc\nWebRTC 能力" as plugin_webrtc
    }

    folder "plugin 平台层" as pkg_platform {
      package "plugin-vault\n密钥与保险库" as plugin_vault
      package "plugin-key-import\n密钥导入流程" as plugin_key_import
      package "plugin-importer-*\n具体导入器" as plugin_importers
      package "plugin-home\n首页" as plugin_home
      package "plugin-settings\n设置" as plugin_settings
      package "plugin-assets\n资产平台" as plugin_assets
      package "plugin-transfer\n转账平台" as plugin_transfer
      package "plugin-apps\nApp Launcher" as plugin_apps
    }

    folder "plugin 业务层" as pkg_business {
      package "plugin-p2pkh\nP2PKH 资产实现" as plugin_p2pkh
      package "plugin-token-*\nToken 资产实现" as plugin_tokens
      package "plugin-collectible-*\nCollectible 资产实现" as plugin_collectibles
      package "plugin-appmsg\nApp 消息" as plugin_appmsg
      package "plugin-message\n消息页" as plugin_message
      package "plugin-contacts\n联系人" as plugin_contacts
      package "plugin-poker\n扑克业务" as plugin_poker
    }
  }

  folder "docs" as docs {
    folder "protocol\n协议草案文档" as docs_protocol
    folder "architecture\n架构与结构文档" as docs_architecture
  }

  folder "scripts\n开发与边界检查脚本" as scripts
  folder "施工单\n设计与变更记录" as workorders
}

app_web --> pkg_runtime : 启动宿主
app_web --> pkg_ui : 组合界面
app_web --> pkg_contracts : 使用类型与协议

pkg_runtime --> pkg_contracts : 依赖协议
pkg_ui --> pkg_contracts : 共享类型

plugin_woc --> pkg_contracts
plugin_background --> pkg_contracts
plugin_protocol --> pkg_contracts
plugin_hubmsg --> pkg_contracts
plugin_webrtc --> pkg_contracts

plugin_vault --> pkg_contracts
plugin_key_import --> pkg_contracts
plugin_importers --> pkg_contracts
plugin_home --> pkg_contracts
plugin_settings --> pkg_contracts
plugin_assets --> pkg_contracts
plugin_transfer --> pkg_contracts
plugin_apps --> pkg_contracts

plugin_p2pkh --> pkg_contracts
plugin_tokens --> pkg_contracts
plugin_collectibles --> pkg_contracts
plugin_appmsg --> pkg_contracts
plugin_message --> pkg_contracts
plugin_contacts --> pkg_contracts
plugin_poker --> pkg_contracts

plugin_woc --> pkg_runtime : 注册 capability
plugin_background --> pkg_runtime
plugin_protocol --> pkg_runtime
plugin_hubmsg --> pkg_runtime
plugin_webrtc --> pkg_runtime

plugin_vault --> pkg_runtime
plugin_key_import --> pkg_runtime
plugin_importers --> pkg_runtime
plugin_home --> pkg_runtime
plugin_settings --> pkg_runtime
plugin_assets --> pkg_runtime
plugin_transfer --> pkg_runtime
plugin_apps --> pkg_runtime

plugin_p2pkh --> pkg_runtime
plugin_tokens --> pkg_runtime
plugin_collectibles --> pkg_runtime
plugin_appmsg --> pkg_runtime
plugin_message --> pkg_runtime
plugin_contacts --> pkg_runtime
plugin_poker --> pkg_runtime

docs_protocol ..> pkg_contracts : 协议对齐
scripts ..> packages : 边界检查
workorders ..> docs_protocol : 记录演进

note bottom of repo
这张图故意不展开插件内部文件结构。
它的目标是说明仓库分层、职责分组和主要依赖方向。
end note

@enduml
```

## 说明

- `apps/web` 是最终装配层，负责把 runtime、UI 和插件装进浏览器应用。
- `packages/contracts` 是跨包协议层，尽量让插件通过 contract 协作，而不是互相直连实现。
- `packages/runtime` 是插件宿主，负责 registry、capability、路由和运行时装配。
- `packages/ui` 是共享 UI 组件层。
- `packages/plugin-*` 按“基础设施 / 平台 / 业务”三组整理，目的是先稳住边界，再承载具体功能。
- `docs/protocol` 放协议草案，`docs/architecture` 放结构和架构文档，避免混放。
