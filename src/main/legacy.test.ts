import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LEGACY_KWIN_MESSAGE, legacyKWinWarning } from "./legacy";

const dirs: string[] = [];

function tempHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-agent-legacy-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function writeKwinRc(home: string, content: string): void {
  fs.mkdirSync(path.join(home, ".config"), { recursive: true });
  fs.writeFileSync(path.join(home, ".config", "kwinrc"), content);
}

describe("legacyKWinWarning", () => {
  it("kwinrc 里启用了旧脚本时给出提示", () => {
    const home = tempHome();
    writeKwinRc(home, "[Plugins]\nauroraeEnabled=true\ndesktop-agentEnabled = true\n\n[x11]\n");
    expect(legacyKWinWarning(home)).toBe(LEGACY_KWIN_MESSAGE);
  });

  it("脚本被显式停用时不提示", () => {
    const home = tempHome();
    writeKwinRc(home, "[Plugins]\ndesktop-agentEnabled=false\n");
    expect(legacyKWinWarning(home)).toBeNull();
  });

  it("没有 kwinrc（非 KDE 或从未装过旧版）时不提示", () => {
    expect(legacyKWinWarning(tempHome())).toBeNull();
  });
});
