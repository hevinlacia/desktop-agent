# Desktop Agent —— 统一命令入口。
# 依赖：pnpm / cargo / pi（运行时）/ KDE Plasma 6（系统集成）

set shell := ["bash", "-cu"]

default:
    @just --list

# 安装前端依赖（pnpm 10+ 需在 pnpm-workspace.yaml 里放行 esbuild 构建脚本）
install:
    pnpm install

# 前端开发服务（不含 Tauri 外壳）
dev:
    pnpm dev

# Tauri 开发模式（前端 HMR + Rust 热重编）
tauri-dev:
    pnpm tauri:dev

# TypeScript 类型检查
typecheck:
    pnpm typecheck

# Rust 检查（含 clippy）
lint:
    cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings

# 单元测试（KWin 脚本生成等纯逻辑）
test:
    cargo test --manifest-path src-tauri/Cargo.toml --lib --bins

# 集成测试：真拉起 pi 子进程，需本机已装 pi 且模型可用
test-integration:
    cargo test --manifest-path src-tauri/Cargo.toml --test pi_integration -- --test-threads=1 --nocapture

# 构建前端产物
build-web:
    pnpm build

# 构建发行版二进制 + 安装包（deb / AppImage）
build:
    pnpm tauri:build

# 交付前全量检查（不含需要真实模型的集成测试）
check: typecheck lint test build-web
    @echo "check 通过"

# 只编译 Rust 主程序（不打包），产物在 src-tauri/target/debug/desktop-agent
build-debug:
    cargo build --manifest-path src-tauri/Cargo.toml

# 运行已编译的 debug 版本
run: build-debug
    ./src-tauri/target/debug/desktop-agent

# 安装到 ~/.local/bin（供 KDE 自定义快捷键 / systemd 调用）
install-local: build
    install -Dm755 src-tauri/target/release/desktop-agent ~/.local/bin/desktop-agent
    @echo "已安装到 ~/.local/bin/desktop-agent"
    @echo "toggle 子命令可绑定到 KDE 自定义快捷键"

# 生成/更新 KWin 脚本（应用启动时会自动做，这里可手动触发）
kwin-install:
    @mkdir -p ~/.local/share/kwin/scripts/desktop-agent/contents/code
    @echo "KWin 脚本由应用启动时自动生成；建议直接 running 应用"

# 查看运行日志
logs:
    journalctl --user -u desktop-agent -f -n 50
