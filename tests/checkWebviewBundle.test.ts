import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, test } from 'vitest';

const bundlePath = resolve('dist/webview.js');
const scriptPath = resolve('scripts/check-webview-bundle.mjs');

/**
 * 优先用真实产物；干净 checkout 尚未 build 时退回一个包含正则字面量的最小样本。
 * 该样本里的反引号正是旧掩码器会误判成模板字符串的形态。
 */
const fallbackSource = [
  'const pattern = /`/;',
  'if (pattern.test("x")) {',
  '  console.log("matched");',
  '}',
].join('\n');

const baseSource = existsSync(bundlePath) ? readFileSync(bundlePath, 'utf8') : fallbackSource;

function runGate(source: string) {
  const directory = mkdtempSync(join(tmpdir(), 'embedpdf-gate-'));
  const file = join(directory, 'webview.js');
  try {
    writeFileSync(file, source);
    return spawnSync(process.execPath, [scriptPath, file], { encoding: 'utf8' });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe('check-webview-bundle', () => {
  test('前置注入 process.env.NODE_ENV 会失败', () => {
    const result = runGate(`console.log(process.env.NODE_ENV);\n${baseSource}`);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('process');
  });

  test('末尾追加 process.env.NODE_ENV 会失败（回归旧掩码器漏洞）', () => {
    const result = runGate(`${baseSource}\nconsole.log(process.env.NODE_ENV);\n`);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('process');
  });

  test('字符串里的 process.env 不误报', () => {
    const result = runGate(`${baseSource}\nconsole.log("process.env");\n`);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('check-webview-bundle: OK');
  });

  test('typeof process 守卫内的引用不误报', () => {
    const result = runGate(
      `${baseSource}\nif (typeof process === "object") { console.log(process.type); }\n`,
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('check-webview-bundle: OK');
  });
});
