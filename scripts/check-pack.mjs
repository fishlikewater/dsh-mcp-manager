// 发布前打包校验：`npm pack --json --dry-run` 检查 tarball 内容。
// - 关键文件必须存在（lib/logic.js 等容易漏进 files 白名单）
// - 测试/夹具/CI 等目录不得泄漏进包
// 本地 npm publish 由 prepublishOnly 触发，CI 也在 pack job 里跑一遍。

import { execFileSync } from 'node:child_process';

const REQUIRED = [
  'package.json',
  'index.js',
  'client.js',
  'lib/logic.js',
  'cordis.patch.yml',
  'README.md',
  'LICENSE',
];

const FORBIDDEN_PREFIXES = ['test/', 'fixtures/', 'scripts/', '.github/'];

let manifests;
try {
  const stdout = execFileSync('npm', ['pack', '--json', '--dry-run'], { encoding: 'utf8' });
  manifests = JSON.parse(stdout);
} catch (error) {
  console.error('npm pack --dry-run 失败：', String(error));
  process.exit(1);
}
const manifest = manifests[0];
if (!manifest || !Array.isArray(manifest.files)) {
  console.error('npm pack 输出异常：', JSON.stringify(manifest));
  process.exit(1);
}

const paths = manifest.files.map((file) => file.path);
const missing = REQUIRED.filter((path) => !paths.includes(path));
if (missing.length > 0) {
  console.error(`缺少必需文件（检查 package.json 的 files 白名单）：${missing.join(', ')}`);
  process.exit(1);
}

const leaked = paths.filter((path) => FORBIDDEN_PREFIXES.some((prefix) => path.startsWith(prefix)));
if (leaked.length > 0) {
  console.error(`不应打包的路径泄漏进包：${leaked.join(', ')}`);
  process.exit(1);
}

console.log(`pack 校验通过：共 ${paths.length} 个文件，必需文件齐全，未泄漏测试/夹具/CI 内容。`);