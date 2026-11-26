import { app } from "electron";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveConfig } from "../shared/config";
import type { AppConfig } from "../shared/protocol";

let current: AppConfig = resolveConfig(null, os.homedir());

/** 固定放在 userData/config.json；Linux 下即 ~/.config/desktop-agent/config.json。 */
export function configPath(): string {
  return path.join(app.getPath("userData"), "config.json");
}

export function getConfig(): AppConfig {
  return current;
}

export interface LoadedConfig {
  config: AppConfig;
  warnings: string[];
}

/** 读取配置。文件不存在时写入默认值方便手改；解析失败则保留原文件并退回默认值。 */
export function loadConfig(): LoadedConfig {
  const warnings: string[] = [];
  const file = configPath();
  let raw: unknown = null;
  let exists = true;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") exists = false;
    else warnings.push(`配置文件解析失败（${file}），已使用默认值：${(err as Error).message}`);
  }

  let config = resolveConfig(raw, os.homedir());
  if (!isDirectory(config.cwd)) {
    warnings.push(`配置的工作目录不存在：${config.cwd}，已改用 ${os.homedir()}`);
    config = { ...config, cwd: os.homedir() };
  }

  current = config;
  if (!exists) writeConfig(config);
  return { config, warnings };
}

/** 校验并保存。工作目录不存在直接报错，不替用户做决定。 */
export function saveConfig(next: AppConfig): AppConfig {
  if (!isDirectory(next.cwd)) {
    throw new Error(`工作目录不存在：${next.cwd}。请在设置里改成一个有效路径`);
  }
  current = resolveConfig(next, os.homedir());
  writeConfig(current);
  return current;
}

function writeConfig(config: AppConfig): void {
  const file = configPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(config, null, 2) + "\n");
}

function isDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}
