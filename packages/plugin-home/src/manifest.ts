// packages/plugin-home/src/manifest.ts
// 首页插件：注册 / 路由和菜单入口。

import {
  CONTACT_PUBLIC_KEY_ACTION_REGISTRY_CAPABILITY,
  KEYSPACE_SERVICE_CAPABILITY
} from "@keymaster/contracts";
import type { I18nPluginResources, PluginManifest } from "@keymaster/contracts";
import { HomePage } from "./HomePage.js";

/** 首页 i18n 资源。设计缘由：route / menu label 走 I18nText，
 * 资源在 plugin setup 之前由 runtime 注入（plugin.i18n）。 */
const homeResources: I18nPluginResources = {
  namespace: "home",
  resources: {
    en: {
      "home.domain.label": "Overview",
      "home.route.label": "Home",
      "home.menu.label": "Home",
      "home.page.title": "Home",
      "home.page.description": "Quick actions.",
      "home.page.empty.title": "No widgets yet",
      "home.page.empty.description": "After installing a business plugin, its panels will appear here.",
      "home.business.empty.title": "No business areas yet",
      "home.business.empty.description": "Enable a business plugin to see its workspace here.",
      "home.actions.label": "Home actions",
      "home.action.scan": "Scan",
      "home.action.myInfo": "My info",
      "home.action.copy": "Copy",
      "home.action.copied": "Copied",
      "home.info.title": "My info",
      "home.info.close": "Close my information",
      "home.info.noKey": "Select an available key to view your information.",
      "home.info.publicKeyQr": "Public-key QR code",
      "home.info.publicKey": "Public key",
      "home.info.address": "Address",
      "home.info.testnetAddress": "Testnet address",
      "home.scan.title": "Scan public-key QR code",
      "home.scan.close": "Close scanner",
      "home.scan.camera": "QR-code scanning camera",
      "home.scan.hint": "Place the other person's public-key QR code in the frame.",
      "home.scan.modeLabel": "Recognition method",
      "home.scan.cameraMode": "Scan",
      "home.scan.imageMode": "From image",
      "home.scan.chooseImage": "Choose image",
      "home.scan.imageHint": "The image is recognized locally on this device and is never uploaded.",
      "home.scan.imagePreview": "Image selected for recognition",
      "home.scan.imageTypeError": "Choose an image file.",
      "home.scan.imageNotFound": "No QR code could be recognized in this image.",
      "home.scan.manual": "Or enter the other person's public key",
      "home.scan.confirm": "Confirm",
      "home.scan.invalid": "The QR code does not contain a valid compressed public key.",
      "home.scan.unsupported": "This browser cannot scan QR codes. Enter the public key manually.",
      "home.scan.cameraError": "Unable to open the camera. Check browser permissions.",
      "home.scan.contactError": "Unable to load the contact information.",
      "home.scan.publicKey": "Their public key",
      "home.scan.contactLoading": "Looking up contact…",
      "home.scan.createContact": "Create contact",
      "home.scan.contactName": "Contact name",
      "home.scan.saveContact": "Save contact",
      "home.scan.createError": "Unable to create contact.",
      "home.scan.actionError": "Action failed. Please try again."
    },
    "zh-CN": {
      "home.domain.label": "概览",
      "home.route.label": "首页",
      "home.menu.label": "首页",
      "home.page.title": "首页",
      "home.page.description": "常用操作。",
      "home.page.empty.title": "还没有 widget",
      "home.page.empty.description": "安装业务插件后这里会显示资源面板。",
      "home.business.empty.title": "暂无业务区域",
      "home.business.empty.description": "启用业务插件后，这里会显示对应工作区。",
      "home.actions.label": "首页操作",
      "home.action.scan": "扫描",
      "home.action.myInfo": "我的信息",
      "home.action.copy": "拷贝",
      "home.action.copied": "已复制",
      "home.info.title": "我的信息",
      "home.info.close": "关闭我的信息",
      "home.info.noKey": "请选择一个可用的密钥后再查看信息。",
      "home.info.publicKeyQr": "公钥二维码",
      "home.info.publicKey": "公钥",
      "home.info.address": "地址",
      "home.info.testnetAddress": "Testnet 地址",
      "home.scan.title": "扫描公钥二维码",
      "home.scan.close": "关闭扫描",
      "home.scan.camera": "二维码扫描画面",
      "home.scan.hint": "将对方的公钥二维码置于取景框内。",
      "home.scan.modeLabel": "识别方式",
      "home.scan.cameraMode": "扫描",
      "home.scan.imageMode": "图片识别",
      "home.scan.chooseImage": "选择图片",
      "home.scan.imageHint": "图片仅在此设备本地识别，不会上传。",
      "home.scan.imagePreview": "待识别图片预览",
      "home.scan.imageTypeError": "请选择一张图片文件。",
      "home.scan.imageNotFound": "未能在这张图片中识别出二维码。",
      "home.scan.manual": "或输入对方公钥",
      "home.scan.confirm": "确认",
      "home.scan.invalid": "二维码中没有有效的压缩公钥。",
      "home.scan.unsupported": "当前浏览器不支持二维码扫描，请手动输入公钥。",
      "home.scan.cameraError": "无法打开相机，请检查浏览器授权。",
      "home.scan.contactError": "无法读取联系人信息。",
      "home.scan.publicKey": "对方公钥",
      "home.scan.contactLoading": "正在查询联系人…",
      "home.scan.createContact": "创建联系人",
      "home.scan.contactName": "联系人名称",
      "home.scan.saveContact": "保存联系人",
      "home.scan.createError": "创建联系人失败。",
      "home.scan.actionError": "操作失败，请重试。"
    }
  }
};

export const homePlugin: PluginManifest = {
  id: "home",
  name: "Home",
  description: "首页容器。",
  meta: {
    kind: "core",
    startup: "optional",
    defaultEnabled: true,
    canDisable: false,
    displayGroup: "core"
  },
  i18n: homeResources,
  dependencies: [
    { capability: "home.registry", reason: "读取首页主栏与侧栏卡片" },
    { capability: "business.registry", reason: "读取业务首页投影" },
    { capability: KEYSPACE_SERVICE_CAPABILITY, reason: "展示当前 key 的身份信息" },
    { capability: "contacts.service", reason: "查询和创建联系人" },
    { capability: CONTACT_PUBLIC_KEY_ACTION_REGISTRY_CAPABILITY, reason: "展示扫描到的公钥可执行操作" }
  ],
  business: {
    domains: [{
      id: "home",
      label: { key: "home.domain.label", fallback: "Overview" },
      order: 0,
      features: [{
        id: "home.overview",
        label: { key: "home.menu.label", fallback: "Home" },
        order: 0,
        icon: "Home",
        entry: { path: "/", component: HomePage }
      }]
    }]
  },
  setup() {}
};
