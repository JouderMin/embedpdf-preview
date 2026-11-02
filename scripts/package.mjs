import { spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';

const output = 'dist/embedpdf-preview.vsix';

// 固定 zip 条目的时间戳，保证连续两次打包得到相同 SHA-256。
// SOURCE_DATE_EPOCH 是 vsce 支持的 reproducible zip 开关。
const env = { ...process.env, SOURCE_DATE_EPOCH: '1700000000' };
const command = process.platform === 'win32' ? 'vsce.cmd' : 'vsce';

try {
  rmSync(output);
} catch (error) {
  if (error.code !== 'ENOENT') {
    throw error;
  }
}

const result = spawnSync(
  command,
  ['package', '--no-dependencies', '-o', output],
  { stdio: 'inherit', env, shell: process.platform === 'win32' },
);

process.exit(result.status ?? 1);
