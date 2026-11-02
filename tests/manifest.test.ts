import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));

describe('扩展清单', () => {
  test('注册自定义编辑器，只按扩展名匹配', () => {
    const editor = pkg.contributes.customEditors[0];
    expect(editor.viewType).toBe('embedpdf.preview');
    expect(editor.selector).toEqual([{ filenamePattern: '*.pdf' }]);
    expect(editor.priority).toBe('option');
  });

  test('激活事件与命令齐全', () => {
    expect(pkg.activationEvents).toEqual(
      expect.arrayContaining(['onStartupFinished', 'onCustomEditor:embedpdf.preview'])
    );
    const ids = pkg.contributes.commands.map((c: { command: string }) => c.command);
    expect(ids).toEqual(expect.arrayContaining(['embedpdf.reload', 'embedpdf.setAsDefault']));
    expect(pkg.engines.vscode).toBe('^1.85.0');
  });

  test('入口与脚本齐全', () => {
    expect(pkg.name).toBe('embedpdf-preview');
    expect(pkg.main).toBe('./dist/extension.js');
    for (const script of ['build', 'watch', 'test', 'package']) {
      expect(pkg.scripts[script], `missing script ${script}`).toBeTypeOf('string');
    }
  });

  test('依赖包含 EmbedPDF、React 与构建工具', () => {
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    for (const name of [
      '@embedpdf/react-pdf-viewer',
      '@embedpdf/pdfium',
      '@embedpdf/fonts-sc',
      '@embedpdf/fonts-latin',
      'react',
      'react-dom',
      'typescript',
      'esbuild',
      'vite',
      '@vitejs/plugin-react',
      'vitest',
      '@types/vscode',
      '@types/react',
      '@types/react-dom',
      '@vscode/vsce',
    ]) {
      expect(deps[name], `missing dependency ${name}`).toBeTypeOf('string');
    }
  });

  test('.gitignore 排除依赖、构建产物与本地记录', () => {
    const ignore = readFileSync('.gitignore', 'utf8').split(/\r?\n/);
    for (const entry of ['node_modules/', 'dist/', '.superpowers/', '*.vsix']) {
      expect(ignore, `missing .gitignore entry ${entry}`).toContain(entry);
    }
  });
});
