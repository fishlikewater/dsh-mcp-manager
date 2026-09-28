// 发布前打包校验：用 `npm pack --json --dry-run` 检查 tarball 内容。
//
// - 白名单里的文件必须都在（examples/ 这类目录最容易在改动 files 时漏掉）；
// - 测试、脚本、CI 配置不得泄漏进包。
//
// `npm publish` 前由 package.json 的 prepublishOnly 自动触发，CI 里也单独跑一遍。
// 用法：node scripts/check-pack.mjs

import { execSync } from 'node:child_process';

const REQUIRED = [
  'package.json',
  'index.js',
  'client.js',
  'cordis.patch.yml',
  'examples/mcp-servers.example.yaml',
  'README.md',
  'CHANGELOG.md',
  'LICENSE',
];

const FORBIDDEN_PREFIXES = ['test/', 'scripts/', 'fixtures/', '.github/'];

let manifest;
try {
  // 用字符串形式的 execSync：Windows 上 npm 是 .cmd，必须经 shell 才能调用。
  const stdout = execSync('npm pack --json --dry-run', { encoding: 'utf8' });
  manifest = JSON.parse(stdout)[0];
} catch (error) {
  console.error('npm pack --dry-run 失败：', String((error && error.message) || error));
  process.exit(1);
}

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

console.log(`pack 校验通过：${paths.length} 个文件，必需文件齐全，未泄漏测试/脚本/CI 内容。`);
