import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const node = process.execPath;

// 资源不参与增量重建，启动时先复制一次；缺失时直接失败。
const copy = spawnSync(node, ['scripts/copy-assets.mjs'], { cwd: root, stdio: 'inherit' });
if (copy.status !== 0) {
  process.exit(copy.status ?? 1);
}

const children = [
  spawn(node, ['scripts/build-extension.mjs', '--watch'], { cwd: root, stdio: 'inherit' }),
  spawn(node, ['node_modules/vite/bin/vite.js', 'build', '--watch'], { cwd: root, stdio: 'inherit' }),
];

let stopping = false;
function stop(code) {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    child.kill('SIGTERM');
  }
  process.exitCode = code ?? 0;
}

for (const child of children) {
  child.on('exit', (code) => stop(code ?? 0));
}
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => stop(0));
}
