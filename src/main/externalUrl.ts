/**
 * 只有 http(s) 地址才交给系统浏览器。
 * 渲染进程里的链接来自模型输出，不可信：`file:`、自定义协议等一律忽略。
 */
export function isWebUrl(url: string): boolean {
  try {
    const { protocol } = new URL(url);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}
