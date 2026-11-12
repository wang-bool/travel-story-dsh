#!/usr/bin/env bash
#
# travel-agent 一键安装脚本
# 将本插件安装到 DSH 的 web profile，并注册到 cordis.patch.yml。
#
# 用法:
#   bash install/install.sh
# 可选环境变量:
#   DSH_HOME      DSH 数据目录（默认 $HOME/.dsh）
#   DSH_PROFILE   目标 profile 名（默认 web）
#
set -euo pipefail

DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
DSH_PROFILE="${DSH_PROFILE:-web}"
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

PROFILE_DIR="$DSH_HOME/profiles/$DSH_PROFILE"
PLUGIN_DIR="$PROFILE_DIR/node_modules/travel-agent"
PATCH_FILE="$PROFILE_DIR/cordis.patch.yml"
PLUGIN_ID="travel-agent"

echo "==> 目标 profile: $PROFILE_DIR"

if [ ! -d "$PROFILE_DIR" ]; then
  echo "错误: profile 目录不存在: $PROFILE_DIR"
  echo "请确认已用 dsh 初始化过 web profile（$DSH_PROFILE），或通过 DSH_PROFILE 指定其它 profile。"
  exit 1
fi

# 1) 复制插件包（package.json + cordis.patch.yml + lib/ + config/）
mkdir -p "$PLUGIN_DIR"
echo "==> 复制插件到 $PLUGIN_DIR"
cp "$SRC_DIR/package.json" "$PLUGIN_DIR/package.json"
cp "$SRC_DIR/cordis.patch.yml" "$PLUGIN_DIR/cordis.patch.yml"
# 先清掉旧目录再复制，避免 cp -r 在已存在的目录里嵌套出 lib/lib
rm -rf "$PLUGIN_DIR/lib" "$PLUGIN_DIR/config" "$PLUGIN_DIR/skills"
cp -r "$SRC_DIR/lib" "$PLUGIN_DIR/lib"
cp -r "$SRC_DIR/config" "$PLUGIN_DIR/config"
cp -r "$SRC_DIR/skills" "$PLUGIN_DIR/skills"

# 2) 注册到 cordis.patch.yml（幂等：已存在则跳过）
if [ ! -f "$PATCH_FILE" ]; then
  echo "==> 创建 $PATCH_FILE"
  cat > "$PATCH_FILE" <<EOF
# dsh profile 用户补丁层。将 travel-agent 插件插入启动列表。
- insert:
    - id: $PLUGIN_ID
      name: '$PLUGIN_ID'
EOF
elif ! grep -q "$PLUGIN_ID" "$PATCH_FILE"; then
  echo "==> 追加插件条目到 $PATCH_FILE"
  {
    printf '\n# travel-agent 旅行规划智能体插件\n'
    printf -- '- insert:\n'
    printf '    - id: %s\n' "$PLUGIN_ID"
    printf "      name: '%s'\n" "$PLUGIN_ID"
  } >> "$PATCH_FILE"
else
  echo "==> $PATCH_FILE 已包含 $PLUGIN_ID，跳过注册"
fi

echo
echo "✔ 安装完成。接下来："
echo "  1. 配置地点搜索密钥（至少一个）：在会话中让模型调用 travel_configure 工具，"
echo "     或直接编辑 $DSH_HOME/travel-agent.config.json（参见插件 config/ 下的示例）。"
echo "  2. 重启 DSH web 服务，并刷新浏览器页面。"
echo "  3. 验证：宿主日志应出现「travel-agent: 插件已加载」；"
echo "     直接和 DSH 说「帮我规划一段 xxx 的行程」即可开始。"
