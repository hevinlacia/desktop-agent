/**
 * 把快捷键配置规整成 Electron accelerator。
 * 旧配置里的 KWin 写法 `Meta+X` 在 Electron 里对应 `Super+X`。
 */
export function normalizeAccelerator(accelerator: string): string {
  return accelerator
    .split("+")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => (/^meta$/i.test(part) ? "Super" : part))
    .join("+");
}
