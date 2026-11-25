#!/bin/bash
# IPwatch 打包脚本 —— 在 macOS / Linux / fnOS 设备上执行（fnpack 不支持 Windows）
# 用法：./build.sh
set -euo pipefail
cd "$(dirname "$0")"

PKG_DIR="ipwatch"

# 1. 安装后端依赖（nodemailer 随包内置，设备端无需联网 npm）
echo "==> npm install (server)"
(cd app/server && npm install --omit=dev --no-audit --no-fund)

# 2. 清理本地测试产生的运行时数据，不进包
rm -rf app/server/data
rm -rf app/server/package-lock.json

# 3. 读取版本号，生成本次包名（保留历史版本，不覆盖）
VERSION=$(awk -F= '/^version=/{gsub(/\r/,"",$2); print $2; exit}' "$PKG_DIR/manifest")
if [ -z "$VERSION" ]; then VERSION="unknown"; fi
BASE_NAME="ipwatch_v${VERSION}"
FPK_NAME="${BASE_NAME}.fpk"
SUFFIX=1
while [ -e "$FPK_NAME" ]; do
  FPK_NAME="${BASE_NAME}_${SUFFIX}.fpk"
  SUFFIX=$((SUFFIX + 1))
done

# 4. 打包（fnpack 默认输出 ipwatch.fpk，随后重命名，绝不覆盖旧版本）
echo "==> fnpack build"
fnpack build --directory "$PKG_DIR"
mv -f "ipwatch.fpk" "$FPK_NAME"

echo "==> 完成：$FPK_NAME"
echo "安装到测试机：appcenter-cli install-local $(pwd)/$FPK_NAME"
