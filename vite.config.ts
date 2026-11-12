import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";

// Tauri 需要固定端口，且不能在端口被占用时自动换端口。
const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { "@": path.resolve(import.meta.dirname, "src") },
  },
  clearScreen: false,
  server: {
    port: 1430,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: "ws", host, port: 1431 } : undefined,
    watch: { ignored: ["**/src-tauri/**"] },
  },
  build: {
    // WebKitGTK（KDE Wayland）比 Chromium 旧，es2021 是其安全边界。
    target: "es2021",
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
    minify: process.env.TAURI_ENV_DEBUG ? false : "esbuild",
    // 单 file 应用，首屏从本地磁盘加载，chunk 拆分的收益低于多一次 IPC 往返。
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
});
