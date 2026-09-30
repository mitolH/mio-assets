#!/usr/bin/env bash
# 可选：安装 pre-commit 钩子，提交前自动跑素材检查。
# 注意：应用内的自动同步(autosync)也是 git commit，钩子失败会让它暂停提交；需要时可用 git commit --no-verify 跳过。
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOOK="$ROOT/.git/hooks/pre-commit"
cat > "$HOOK" <<'HOOK_EOF'
#!/usr/bin/env bash
cd "$(git rev-parse --show-toplevel)" && npm test --silent
HOOK_EOF
chmod +x "$HOOK"
echo "已安装 pre-commit 钩子: $HOOK"
