import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "@shared": path.resolve(import.meta.dirname, "src/shared"),
      // 渲染层 store 单测用：useAgentStore 以 `@/services/agentClient` 引用 IPC 出口，
      // 与 electron.vite / tsconfig.web 的映射一致（@ → src/renderer）。
      "@": path.resolve(import.meta.dirname, "src/renderer"),
    },
  },
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
  },
});
