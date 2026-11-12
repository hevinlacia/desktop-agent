import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** 毫秒时间戳 → 本地 HH:mm。 */
export function formatTime(ms: number): string {
  if (!ms) return "";
  return new Date(ms).toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** token 数的紧凑展示：1200 → 1.2k。 */
export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

/** 把工具参数压成一行摘要，供折叠卡片标题使用。 */
export function summarizeArgs(args: unknown): string {
  if (args === null || args === undefined) return "";
  if (typeof args === "string") return truncate(args, 80);
  if (typeof args !== "object") return String(args);
  const obj = args as Record<string, unknown>;
  // 优先展示最能说明意图的字段。
  for (const key of ["command", "path", "file_path", "query", "pattern", "url", "description"]) {
    const v = obj[key];
    if (typeof v === "string" && v) return truncate(v, 80);
  }
  try {
    return truncate(JSON.stringify(obj), 80);
  } catch {
    return "";
  }
}

export function truncate(s: string, max: number): string {
  const oneLine = s.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
}
