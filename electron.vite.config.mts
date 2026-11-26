import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";
import type { Plugin } from "vite";

const root = import.meta.dirname;
const sharedAlias = { "@shared": path.resolve(root, "src/shared") };

/**
 * 生产构建注入 CSP（Electron 安全基线）。
 * 开发态不注入：Vite 的 HMR 与 React Refresh 依赖内联脚本。
 * `wasm-unsafe-eval` 是 shiki 的高亮引擎（WASM）需要的。
 */
function csp(): Plugin {
  return {
    name: "desktop-agent:csp",
    apply: "build",
    transformIndexHtml() {
      return [
        {
          tag: "meta",
          attrs: {
            "http-equiv": "Content-Security-Policy",
            content:
              "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; " +
              "img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; worker-src 'self' blob:",
          },
          injectTo: "head-prepend",
        },
      ];
    },
  };
}

export default defineConfig({
  // 主进程：两个入口。agent.js 是 utility 子进程，跑 pi SDK。
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: sharedAlias },
    build: {
      rollupOptions: {
        input: {
          index: path.resolve(root, "src/main/index.ts"),
          agent: path.resolve(root, "src/agent/index.ts"),
        },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: sharedAlias },
  },
  renderer: {
    // 渲染进程可以直接 import src/shared 下的契约类型。
    resolve: {
      alias: {
        "@": path.resolve(root, "src/renderer"),
        ...sharedAlias,
      },
    },
    plugins: [react(), tailwindcss(), csp()],
    build: {
      // electron-vite 默认不压缩；渲染层体积大，按普通 Web 产物压缩。主进程保留可读堆栈。
      minify: "esbuild",
      chunkSizeWarningLimit: 900,
      rollupOptions: {
        output: {
          manualChunks: {
            // shiki 的 wasm + 语法文件体积最大，且只在渲染代码块时才需要。
            shiki: ["shiki"],
            markdown: ["react-markdown", "remark-gfm"],
          },
        },
      },
    },
  },
});
