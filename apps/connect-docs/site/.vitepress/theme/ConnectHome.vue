<script setup lang="ts">
import { withBase } from "vitepress";

const sourceUrl = __CONNECT_SOURCE_URL__;

const capabilities = [
  ["Identity", "Authenticate users and issue signed claims", "identity.get"],
  ["Cryptography", "Sign intent and encrypt origin-bound data", "intent.sign · cipher.*"],
  ["Communication", "Send private messages and signed broadcasts", "appmsg.* · broadcast.*"],
  ["Storage", "Work inside an app-scoped object namespace", "storage.*"],
  ["Payments", "Request controlled BSV transfers and fee-pool operations", "p2pkh.* · feepool.*"]
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
        <h1 id="connect-title">Capabilities in.<br><span>Private keys stay out.</span></h1>
        <p class="hero-summary">
          Build browser apps that request identity, cryptography, messaging,
          storage, and payment capabilities from Keymaster.
        </p>
        <div class="hero-actions">
          <a class="primary-action" :href="withBase('/guide/getting-started')">Start integrating <span>→</span></a>
          <a class="secondary-action" :href="withBase('/api/')">Read the API</a>
        </div>
        <div class="install-line" aria-label="Install package">
          <span class="prompt">$</span>
          <code>pnpm add @keymaster/connect</code>
        </div>
      </div>

      <p class="hero-footnote">POSTMESSAGE TRANSPORT · EXACT ORIGIN · SESSION-BOUND</p>
    </section>

    <section class="capability-section" aria-labelledby="capability-title">
      <div class="section-intro">
        <p class="section-index">01 / CAPABILITIES</p>
        <h2 id="capability-title">One session.<br>Five capability systems.</h2>
        <p>Every business request is bound to the identity and origin chosen for the Connect session.</p>
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
        <p class="section-index">02 / CONNECTION MODEL</p>
        <h2 id="flow-title">A window is transport.<br>A session is authority.</h2>
      </div>
      <ol class="flow-steps">
        <li>
          <span>01</span>
          <h3>Connect</h3>
          <p>Open a reusable Session Window, or adopt the opener in appView mode.</p>
        </li>
        <li>
          <span>02</span>
          <h3>Authorize</h3>
          <p>The user chooses an owner identity. The SDK receives a persistent session id.</p>
        </li>
        <li>
          <span>03</span>
          <h3>Request</h3>
          <p>Call typed methods. Keymaster owns confirmation, private material, and execution.</p>
        </li>
      </ol>
    </section>

    <section class="final-section">
      <p class="section-index">03 / BUILD</p>
      <h2>The API is the SDK.<br>No documentation adapter in between.</h2>
      <p>Every reference page is generated directly from the package exports developers install.</p>
      <div class="final-actions">
        <a class="primary-action" :href="withBase('/guide/getting-started')">Open the guide <span>→</span></a>
        <a v-if="sourceUrl" class="secondary-action" :href="sourceUrl">View source</a>
      </div>
    </section>
  </main>
</template>
