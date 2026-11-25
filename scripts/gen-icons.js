// 从 scripts/logo-source.png 生成 IPwatch 各尺寸图标（开发期工具）
// 使用系统 Python + Pillow 做 LANCZOS 高质量缩放；源图为盾牌 + 眼睛 + 绿色在线圆点。
// 用法：node scripts/gen-icons.js
'use strict';
const { execFileSync } = require('child_process');
const path = require('path');

const root = path.join(__dirname, '..');
const py = `
from PIL import Image
import os, sys
root = sys.argv[1]
src = Image.open(os.path.join(root, 'scripts', 'logo-source.png')).convert('RGBA')
targets = [
    ('ICON.PNG', 512),
    ('ICON_256.PNG', 256),
    ('app/ui/images/icon_64.png', 64),
    ('app/ui/images/icon_256.png', 256),
]
for rel, size in targets:
    out = os.path.join(root, rel)
    os.makedirs(os.path.dirname(out), exist_ok=True)
    src.resize((size, size), Image.LANCZOS).save(out)
    print('written', rel, size, 'bytes', os.path.getsize(out))
`;

try {
  const out = execFileSync('python', ['-c', py, root], { encoding: 'utf8' });
  process.stdout.write(out);
} catch (e) {
  console.error('图标生成失败：需要 Python + Pillow（pip install pillow）');
  console.error(String(e.stderr || e.message));
  process.exit(1);
}
