// packages/ui/src/Button.test.ts
// 硬切换 007：Button 必须 fail-closed，未传 type 时默认 type="button"，
// 显式 type="submit" / "reset" 不能被默认值覆盖。
//
// 用 react-dom/server 做静态渲染，不引入新的浏览器测试框架。

import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Button } from "./Button.js";

describe("Button", () => {
  it("defaults to type=\"button\" when type prop is not provided", () => {
    const html = renderToStaticMarkup(<Button>Click me</Button>);
    expect(html).toContain('type="button"');
    expect(html).not.toContain('type="submit"');
  });

  it("preserves explicit type=\"submit\"", () => {
    const html = renderToStaticMarkup(<Button type="submit">Submit</Button>);
    expect(html).toContain('type="submit"');
  });

  it("preserves explicit type=\"reset\"", () => {
    const html = renderToStaticMarkup(<Button type="reset">Reset</Button>);
    expect(html).toContain('type="reset"');
  });
});
