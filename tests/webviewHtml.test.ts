import { describe, expect, test } from 'vitest';
import { renderHtml } from '../src/extension/webviewHtml';

const input = {
  cspSource: 'vscode-resource://x',
  scriptUri: 'vscode-resource://x/webview.js',
  styleUri: 'vscode-resource://x/webview.css',
  nonce: 'n1',
};

describe('renderHtml', () => {
  test('CSP 放开 blob 图片、wasm 与字体，且不放开 https', () => {
    const html = renderHtml(input);
    expect(html).toContain("script-src 'nonce-n1' 'wasm-unsafe-eval'");
    expect(html).toContain('font-src vscode-resource://x');
    expect(html).toContain('img-src vscode-resource://x data: blob:');
    expect(html).toContain('nonce="n1"');
    expect(html).not.toContain('https:');
  });

  test('不同 nonce 生成不同 HTML，且各自包含自己的 nonce', () => {
    const first = renderHtml({ ...input, nonce: 'nonce-a' });
    const second = renderHtml({ ...input, nonce: 'nonce-b' });
    expect(first).not.toBe(second);
    expect(first).toContain('nonce-a');
    expect(first).not.toContain('nonce-b');
    expect(second).toContain('nonce-b');
    expect(second).not.toContain('nonce-a');
  });

  test('加载固定产物并保留 root 容器', () => {
    const html = renderHtml(input);
    expect(html).toContain('<div id="root"></div>');
    expect(html).toContain('src="vscode-resource://x/webview.js"');
    expect(html).toContain('href="vscode-resource://x/webview.css"');
    expect(html).toContain('type="module"');
    expect(html).toContain('connect-src vscode-resource://x');
    expect(html).toContain('media-src vscode-resource://x');
  });
});
