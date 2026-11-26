# Desktop Agent —— 统一命令入口。
# 依赖：Node 22+ / Bun 1.2+（just 本身由 mise 按项目 .mise.toml 提供）。
# Bun 只负责装依赖和启动脚本；构建工具与 Electron 本身跑在 Node 上。

set shell := ["bash", "-cu"]

# Electron 二进制默认从 GitHub 下载，国内网络经常卡死，统一改走 npmmirror（可用环境变量覆盖）。
electron_mirror := "https://npmmirror.com/mirrors/electron/"

default:
    @just --list

# 安装依赖，并提前把 Electron 二进制下好。
# Electron 45 起没有 postinstall，二进制要到首次运行才下载；不提前下，之后某次启动才会去连 GitHub。
install:
    bun install
    [ -f node_modules/electron/path.txt ] || ELECTRON_MIRROR="${ELECTRON_MIRROR:-{{electron_mirror}}}" node node_modules/electron/install.js

# 开发模式：渲染进程 HMR，主进程改动自动重启
dev:
    bun run dev

# 构建主进程 / 预加载 / Agent 子进程 / 渲染进程到 out/
build:
    bun run build

# 运行已构建的产物（不打包）
start: build
    bun run start

# TypeScript 类型检查（node 侧 + web 侧两个 tsconfig）
typecheck:
    bun run typecheck

# 单元测试（vitest）
test:
    bun run test

# 交付前检查
check: typecheck test build
    @echo "check 通过"

# 打包安装包。默认只打 pacman；要别的目标就在后面点名，如 just package appimage deb。
# 第一个参数也可以是平台（linux / mac / win，后两个未验证）：just package mac dmg。
# 维护者取自本机 git 身份，邮箱不写进仓库；镜像地址可用环境变量覆盖。
# 前提：打 deb / rpm / pacman 时 Arch 上要装 libxcrypt-compat（electron-builder 自带的 fpm 依赖 libcrypt.so.1）。
package *targets: build
    #!/usr/bin/env bash
    set -euo pipefail
    export ELECTRON_MIRROR="${ELECTRON_MIRROR:-{{electron_mirror}}}"
    export ELECTRON_BUILDER_BINARIES_MIRROR="${ELECTRON_BUILDER_BINARIES_MIRROR:-https://npmmirror.com/mirrors/electron-builder-binaries/}"
    platform=linux
    # shebang 配方拿不到位置参数，只能用插值把调用方给的参数写进脚本。
    targets=({{targets}})
    if [[ ${#targets[@]} -gt 0 && " linux mac win " == *" ${targets[0]} "* ]]; then
        platform=${targets[0]}
        targets=("${targets[@]:1}")
    fi
    # linux 不点名时只打 pacman；其它平台沿用 electron-builder.yml 里配置的目标。
    if [[ ${#targets[@]} -eq 0 && "$platform" == linux ]]; then targets=(pacman); fi
    # electron-builder 给 pacman 包起的名字是 .pacman，pacman -U 只认 .pkg.tar.xz。
    bun run electron-builder "--$platform" "${targets[@]}" -c.linux.maintainer="$(git config user.name) <$(git config user.email)>"
    shopt -s nullglob
    for pkg in release/*.pacman; do mv "$pkg" "${pkg%.pacman}.pkg.tar.xz"; done

# 端到端自检：启动应用走完整条链路（两种形态布局、两轮真实提问、链接安全）后退出，退出码即结果。详见 docs/testing.md。
smoke: build
    DESKTOP_AGENT_SELFTEST=tmp/selftest bun run start
