import {nativeSdkSources} from './native-sdk-sources.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { HardwareConnectionOwner } from '../dist/index.js';

// 实际 C++ Endpoint、真实 MessageChannel、真实配对/持有权密码学。
// 设备上的决定仍来自公开 HostApproval 适配，不是实体按键验收。
test('hardware connection owner: actual C++ proof, device-only pairing, occupied lease, revoke and wrong key', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'rockey-connection-'));
  const root = process.env.ROCKEY_ROOT ?? join(fileURLToPath(new URL('../../../../../', import.meta.url)), 'Rockey');
  const prefix = process.env.VLP_MBEDTLS_PREFIX ?? '/opt/homebrew/opt/mbedtls@3';
  const exe = join(dir, 'device');
  const compiled = spawnSync('c++', ['-std=c++17', '-Wall', '-Wextra', '-Werror', '-fsanitize=address,undefined', `-I${prefix}/include`, ...nativeSdkSources(root), join(root, 'Coding/Rockey/vaultlink-integration/tests/native.cpp'), `-L${prefix}/lib`, `-Wl,-rpath,${prefix}/lib`, '-lmbedtls', '-lmbedx509', '-lmbedcrypto', '-o', exe], { encoding: 'utf8' });
  assert.equal(compiled.status, 0, compiled.stderr);
  const pub = '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798';
  try {
    for (const mode of ['allow', 'enroll', 'device-close', 'revoke', 'cancel', 'wrong-key']) {
      const device = spawn(exe, [join(dir, mode)]);
      const exited = once(device, 'exit'); let stderr = '';
      device.stderr.setEncoding('utf8'); device.stderr.on('data', s => stderr += s);
      const iterator = device.stdout[Symbol.asyncIterator]();
      const channel = new MessageChannel(), leaseId = crypto.randomUUID();
      channel.port1.onmessage = async e => {
        const m = e.data;
        if (m.lease !== leaseId) return;
        if (m.type === 'write') {
          try {
            if (!device.stdin.write(m.bytes)) await once(device.stdin, 'drain');
            channel.port1.postMessage({ type: 'written', lease: leaseId, id: m.id, ok: true });
          } catch { channel.port1.postMessage({ type: 'closed', lease: leaseId }); }
        } else if (m.type === 'close') { device.stdin.end(); channel.port1.close(); }
      };
      void (async () => {
        for (;;) {
          const next = await iterator.next(); if (next.done) break;
          channel.port1.postMessage({ type: 'data', lease: leaseId, bytes: new Uint8Array(next.value) });
        }
        try { channel.port1.postMessage({ type: 'closed', lease: leaseId }); } catch {}
      })();
      const owner = new HardwareConnectionOwner(() => {});
      const document = {bsvNetwork: "main",  format: 'keymaster.hardware-key', version: 1, backend: 'vaultlink', wireVersion: 2,
        label: 'Known test key', publicKeyHex: mode === 'wrong-key' ? '02c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5' : pub,
        walletGeneration: crypto.randomUUID(), backendGeneration: 3 };
      const controller = new AbortController();
      const pending = mode === 'enroll' ? owner.enroll({peerId: 'control-page', leaseId, port: channel.port2, label: 'New RocKey', walletGeneration: document.walletGeneration, signal: controller.signal, assertRecordLive() {}}) : owner.attach({ peerId: 'control-page', leaseId, port: channel.port2, document, signal: controller.signal, assertRecordLive() {} });
      const settled = pending.then(value => ({ value }), error => ({ error }));
      try {
        if (mode === 'revoke') controller.abort();
        else if(mode==='cancel') await owner.disconnect('control-page',leaseId);
        if (mode === 'wrong-key'||mode==='revoke'||mode==='cancel') {
          const result = await settled;
          assert.ok(result.error); assert.equal(owner.state().status, 'disconnected');
        } else {
          // No browser answer: the real device approval/proof completes the connection.
          const result=await settled;
          assert.equal(result.value.status,'connected');
          assert.equal(owner.verifiedDocument().publicKeyHex,pub);
          assert.equal(owner.state().pairingCode,undefined);
          const duplicate = new MessageChannel();
          await assert.rejects(owner.attach({peerId:'another-page',leaseId:crypto.randomUUID(),port:duplicate.port2,document,assertRecordLive(){}}),/usb-in-use/);
          duplicate.port1.close();
          assert.throws(()=>owner.disconnect('another-page',leaseId),/stale-usb-lease/);
          await owner.closePeer('another-page');assert.equal(owner.state().status,'connected');
          if(mode==='device-close'){
            device.stdin.end();
            const until=Date.now()+2000;
            while(owner.state().status!=='disconnected'&&Date.now()<until)await new Promise(r=>setTimeout(r,5));
          }else await owner.closePeer('control-page');
          assert.equal(owner.state().status,'disconnected');
        }
      } finally {
        await owner.close(); channel.port1.close(); channel.port2.close(); device.stdin.end();
        const timer = setTimeout(() => device.kill('SIGKILL'), 3000);
        const [code] = await exited; clearTimeout(timer); assert.equal(code, 0, stderr);
      }
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});
