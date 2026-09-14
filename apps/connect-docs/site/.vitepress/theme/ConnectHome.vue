<script setup lang="ts">
import { withBase } from "vitepress";

const sourceUrl = __CONNECT_SOURCE_URL__;

const capabilities = [
  ["身份", "登录用户并签发身份断言", "identity.get"],
  ["密码学", "签署意图并加密来源绑定数据", "intent.sign · cipher.*"],
  ["通信", "发布和订阅已签名频道消息", "channel.*"],
  ["存储", "在 App 隔离对象空间中读写", "storage.*"],
  ["文件", "查询并读取 MSFile 内容", "msfile.*"],
  ["支付", "请求受控 BSV 转账和费用池操作", "p2pkh.* · feepool.*"]
];
</script>

<template>
  <main class="connect-home">
    <section class="connect-hero" aria-labelledby="connect-title">
      <div class="protocol-field" aria-hidden="true">
        <div class="protocol-orbit orbit-one" />
        <div class="protocol-orbit orbit-two" />
        <div class="protocol-node node-a">APP</div>
        <div class="protocol-node node-b">SESSION</div>
        <div class="protocol-node node-c">KEYMASTER</div>
        <div class="protocol-packet packet-one">request · identity.get</div>
        <div class="protocol-packet packet-two">result · approved</div>
        <div class="protocol-packet packet-three">event · message_received</div>
      </div>

      <div class="hero-copy">
        <p class="hero-kicker">@keymaster/connect · browser SDK</p>
        <h1 id="connect-title">开放能力，<br><span>私钥不出 Keymaster。</span></h1>
        <p class="hero-summary">
          浏览器 App 可以请求身份、密码学、消息、存储、文件和支付能力，
          但不会取得用户私钥。
        </p>
        <div class="hero-actions">
          <a class="primary-action" :href="withBase('/guide/getting-started')">开始接入 <span>→</span></a>
          <a class="secondary-action" :href="withBase('/api/')">查看 API</a>
        </div>
        <div class="install-line" aria-label="安装包">
          <span class="prompt">$</span>
          <code>pnpm add @keymaster/connect</code>
        </div>
      </div>

      <p class="hero-footnote">POSTMESSAGE 传输 · 精确来源 · 会话绑定</p>
    </section>

    <section class="capability-section" aria-labelledby="capability-title">
      <div class="section-intro">
        <p class="section-index">01 / 能力</p>
        <h2 id="capability-title">一个会话，<br>六类受控能力。</h2>
        <p>每个业务请求都绑定 Connect 会话选择的身份和来源。</p>
      </div>
      <div class="capability-list">
        <a v-for="([title, detail, methods], index) in capabilities" :key="title" :href="withBase('/guide/capabilities')" class="capability-row">
          <span class="row-number">0{{ index + 1 }}</span>
          <strong>{{ title }}</strong>
          <span class="row-detail">{{ detail }}</span>
          <code>{{ methods }}</code>
          <span class="row-arrow">↗</span>
        </a>
      </div>
    </section>

    <section class="flow-section" aria-labelledby="flow-title">
      <div class="flow-heading">
        <p class="section-index">02 / 连接模型</p>
        <h2 id="flow-title">窗口负责传输，<br>会话代表授权。</h2>
      </div>
      <ol class="flow-steps">
        <li>
          <span>01</span>
          <h3>连接</h3>
          <p>打开可复用 Session Window，或在 appView 中复用 opener。</p>
        </li>
        <li>
          <span>02</span>
          <h3>授权</h3>
          <p>用户选择 Owner 身份，SDK 获得持久会话编号。</p>
        </li>
        <li>
          <span>03</span>
          <h3>请求</h3>
          <p>调用类型化方法；Keymaster 负责确认、私密材料和执行。</p>
        </li>
      </ol>
    </section>

    <section class="final-section">
      <p class="section-index">03 / 构建</p>
      <h2>API 就是 SDK，<br>不维护第二份字段文档。</h2>
      <p>字段页面直接从开发者安装的包导出和中文注释生成。</p>
      <div class="final-actions">
        <a class="primary-action" :href="withBase('/guide/getting-started')">打开指南 <span>→</span></a>
        <a v-if="sourceUrl" class="secondary-action" :href="sourceUrl">查看源码</a>
      </div>
    </section>
  </main>
</template>
