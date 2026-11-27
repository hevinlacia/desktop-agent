import { describe, expect, it } from "vitest";
import source from "./highlight.ts?raw";

/**
 * 守住 REQ-342 那条坑：语言包必须用**字面量** specifier 动态 import。
 *
 * 模板字符串（import(`shiki/langs/${l}.mjs`)）Vite 分析不了，会原样留在产物里；
 * 渲染进程拿裸包名去 import 必然失败，高亮整条链路静默降级成纯文本。而单测在 Node 下
 * 解析裸包名是能成功的，功能测试挡不住这种退化 —— 所以扫源码兜底。
 * 用 `?raw` 读源码：渲染层 tsconfig 只有 Vite/DOM 类型，没有 node:fs。
 */
// 扫代码本体：注释里出现反例写法是正常的（本文件就有一处说明）。
const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("highlight.ts 的模块加载写法", () => {
  it("没有模板字符串形式的 import()", () => {
    expect(code).not.toMatch(/import\(\s*`/);
  });

  it("每个语言一条字面量 import", () => {
    const loaders = [...code.matchAll(/import\(\s*"(shiki\/langs\/[^"]+\.mjs)"\s*\)/g)].map((m) => m[1]);
    const langs = /const LANGS = \[([\s\S]*?)\] as const;/.exec(code)?.[1] ?? "";
    const names = [...langs.matchAll(/"([a-z]+)"/g)].map((m) => m[1]);
    expect(names.length).toBeGreaterThan(0);
    expect(loaders).toHaveLength(names.length);
    for (const name of names) expect(loaders).toContain(`shiki/langs/${name}.mjs`);
  });
});
