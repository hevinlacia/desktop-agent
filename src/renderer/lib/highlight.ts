/**
 * 代码高亮 + Markdown 渲染。
 *
 * 用 shiki 而不是 rehype-highlight 的原因：shiki 输出精确的 TextMate 语法着色，
 * 且能被 Tailwind 主题变量控制背景。代价是异步初始化，所以用单例缓存 + Suspense-free 降级。
 *
 * 体积控制：只注册实际用到的语言，不让 shiki 拉全量 grammar。
 */
import { createHighlighterCore, type HighlighterCore } from "shiki/core";
import { createOnigurumaEngine } from "shiki/engine/oniguruma";

const LANGS = [
  "typescript",
  "tsx",
  "javascript",
  "jsx",
  "json",
  "rust",
  "bash",
  "shell",
  "python",
  "java",
  "sql",
  "yaml",
  "toml",
  "markdown",
  "html",
  "css",
  "xml",
  "diff",
  "go",
] as const;

const THEME_DARK = "github-dark-default";
const THEME_LIGHT = "github-light-default";

let highlighterPromise: Promise<HighlighterCore> | null = null;
const cache = new Map<string, string>();

function getHighlighter(): Promise<HighlighterCore> {
  highlighterPromise ??= createHighlighterCore({
    themes: [
      import("shiki/themes/github-dark-default.mjs"),
      import("shiki/themes/github-light-default.mjs"),
    ],
    langs: LANGS.map((l) => import(`shiki/langs/${l}.mjs`)),
    engine: createOnigurumaEngine(import("shiki/wasm")),
  });
  return highlighterPromise;
}

function prefersDark(): boolean {
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;
}

/**
 * 高亮一段代码，返回 HTML。
 * 未就绪时返回 null，调用方降级成纯文本（不要阻塞首屏）。
 */
export async function highlightCode(
  code: string,
  lang: string | undefined,
): Promise<string | null> {
  const language = normalizeLang(lang);
  const key = `${language}\u0000${prefersDark() ? "d" : "l"}\u0000${code}`;
  const hit = cache.get(key);
  if (hit) return hit;

  try {
    const hl = await getHighlighter();
    const html = hl.codeToHtml(code, {
      lang: language,
      theme: prefersDark() ? THEME_DARK : THEME_LIGHT,
    });
    // 简单 LRU：超出 200 条清掉最早的一半，避免长时间会话吃满内存。
    if (cache.size > 200) {
      const keys = [...cache.keys()].slice(0, 100);
      for (const k of keys) cache.delete(k);
    }
    cache.set(key, html);
    return html;
  } catch {
    return null;
  }
}

function normalizeLang(lang: string | undefined): string {
  const l = (lang ?? "").toLowerCase().trim();
  if (!l) return "text";
  const alias: Record<string, string> = {
    ts: "typescript",
    js: "javascript",
    sh: "bash",
    zsh: "bash",
    console: "bash",
    rs: "rust",
    py: "python",
    yml: "yaml",
    md: "markdown",
    htm: "html",
    golang: "go",
    text: "text",
    txt: "text",
  };
  const mapped = alias[l] ?? l;
  return (LANGS as readonly string[]).includes(mapped) ? mapped : "text";
}
