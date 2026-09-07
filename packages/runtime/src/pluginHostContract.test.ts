// Keymaster Host 与 WebLoom Host 的绑定边界测试。
//
// 生产代码不允许用兼容对象代替 WebLoom Host；测试若需要通用 Host，必须
// 从 webloom-framework/testing 显式创建并通过 bindWebLoomHost 绑定。

import { describe, expect, it } from "vitest";
import { createFakePluginHost } from "webloom-framework/testing";
import type { PluginHost } from "./pluginHostContract.js";
import { bindWebLoomHost, getWebLoomHost } from "./pluginHostContract.js";

describe("Keymaster WebLoom Host binding", () => {
  it("未绑定 WebLoom Host 时必须 fail closed", () => {
    expect(() => getWebLoomHost({} as PluginHost)).toThrow(
      "Keymaster PluginHost is not bound to a WebLoom Host",
    );
  });

  it("测试夹具显式绑定 webloom-framework/testing Host", () => {
    const keymasterHost = {} as PluginHost;
    const webLoomHost = createFakePluginHost();

    bindWebLoomHost(keymasterHost, webLoomHost);

    expect(getWebLoomHost(keymasterHost)).toBe(webLoomHost);
  });
});
