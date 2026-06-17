// packages/plugin-home/src/HomePage.test.ts
// 硬切换 006：首页栏目分发 + 同栏目内顺序行为。
//   - 纯函数 partitionHomeWidgets 把 widgets 按 slot 分为 main / aside。
//   - 同一栏目内保持输入顺序（即 registry.list() 的 order 升序结果）。
//   - 空输入返回空分组，不抛错。
//   - 关键不变量：HomeWidget 上不再存在 size 字段；首页不再消费 size。
//   - 关键不变量：partitionHomeWidgets 不会"借" widget 去填另一栏。

import { describe, expect, it } from "vitest";
import type { ComponentType } from "react";
import type { HomeWidget } from "@keymaster/contracts";
import { partitionHomeWidgets } from "./HomePage.js";

function makeWidget(id: string, slot: HomeWidget["slot"], order: number): HomeWidget {
  const Comp: ComponentType = () => null;
  return {
    id,
    title: { key: `home.test.${id}`, fallback: id },
    component: Comp,
    order,
    slot
  };
}

describe("partitionHomeWidgets (硬切换 006)", () => {
  it("按 slot 把 widgets 分发到 main / aside", () => {
    const widgets: HomeWidget[] = [
      makeWidget("assets.overview", "main", 5),
      makeWidget("contacts.recent", "aside", 30),
      makeWidget("p2pkh.balance", "main", 20),
      makeWidget("poker.status", "aside", 30)
    ];
    const { main, aside } = partitionHomeWidgets(widgets);
    expect(main.map((w) => w.id)).toEqual(["assets.overview", "p2pkh.balance"]);
    expect(aside.map((w) => w.id)).toEqual(["contacts.recent", "poker.status"]);
  });

  it("同栏目内保持输入顺序（registry 已按 order 升序给出）", () => {
    // 模拟 registry.list() 给出的升序输入：
    // aside 30 (poker), aside 35 (extra), main 10 (a), main 20 (b)
    const widgets: HomeWidget[] = [
      makeWidget("poker.status", "aside", 30),
      makeWidget("extra.aside", "aside", 35),
      makeWidget("a.main", "main", 10),
      makeWidget("b.main", "main", 20)
    ];
    const { main, aside } = partitionHomeWidgets(widgets);
    expect(main.map((w) => w.id)).toEqual(["a.main", "b.main"]);
    expect(aside.map((w) => w.id)).toEqual(["poker.status", "extra.aside"]);
  });

  it("空输入返回空分组且不抛错", () => {
    const { main, aside } = partitionHomeWidgets([]);
    expect(main).toEqual([]);
    expect(aside).toEqual([]);
  });

  it("只有 main / 只有 aside 时另一侧为空", () => {
    const onlyMain = partitionHomeWidgets([makeWidget("a", "main", 1)]);
    expect(onlyMain.main.map((w) => w.id)).toEqual(["a"]);
    expect(onlyMain.aside).toEqual([]);

    const onlyAside = partitionHomeWidgets([makeWidget("b", "aside", 1)]);
    expect(onlyAside.aside.map((w) => w.id)).toEqual(["b"]);
    expect(onlyAside.main).toEqual([]);
  });

  it("不会把 main widget 借到 aside 填空白，反之亦然", () => {
    // 情况 1：aside 为空。
    const a = partitionHomeWidgets([makeWidget("a", "main", 1)]);
    expect(a.aside).toEqual([]);
    expect(a.main).toHaveLength(1);

    // 情况 2：main 为空。
    const b = partitionHomeWidgets([makeWidget("b", "aside", 1)]);
    expect(b.main).toEqual([]);
    expect(b.aside).toHaveLength(1);
  });
});

describe("HomeWidget 契约不变量 (硬切换 006)", () => {
  it("HomeWidget 上不再存在 size 字段（类型层硬证据）", () => {
    // 编译期硬证据 1：keyof 不含 "size"。
    //   - 若 size 字段被复活，`"size" extends keyof HomeWidget` 为 true，
    //     `NoSizeField` 退化成 false，下面的 const 赋值会因类型不匹配报错。
    //   - 反之 `NoSizeField = true`，赋值通过。
    //   这一行与 HomeWidget 其它字段是否变化无关——它只看"size 是否在
    //   keyof 集合里"，是最直接的不变量证据。
    type NoSizeField = "size" extends keyof HomeWidget ? false : true;
    const noSizeField: NoSizeField = true;

    // 编译期硬证据 2：超额属性检查。直接在 HomeWidget 位置上写含 size
    // 的对象字面量，TS 会因 excess property 报错。这里用对象字面量直接
    // 传给函数参数（保留 excess property 检查）——比先把对象存到变量
    // 再赋给 HomeWidget 更可靠：后者会丢失 excess property check。
    function takeWidget(_w: HomeWidget): void {
      void _w;
    }
    takeWidget({
      id: "x",
      title: { key: "home.test.x", fallback: "X" },
      component: () => null,
      order: 1,
      slot: "main",
      // @ts-expect-error size 字段已被删除；含 size 的对象字面量直接传参
      //   时 TS 会因 excess property 检查报错。若 size 字段被复活，下面
      //   这条会变成"未使用 @ts-expect-error"——这是测试自我保护的关键。
      size: "md"
    });

    // 给 noSizeField 一个运行时引用，避免 TS 把"未使用变量"误判为
    // 不影响编译；这里用 expect 锁住它的运行时值，运行时为 true 才通过。
    expect(noSizeField).toBe(true);
  });
});
