import { describe, expect, test } from 'vitest';
import { renderHtml } from '../src/extension/webviewHtml';

const input = {
  cspSource: 'vscode-resource://x',
  scriptUri: 'vscode-resource://x/webview.js',
  styleUri: 'vscode-resource://x/webview.css',
  nonce: 'n1',
};

describe('renderHtml', () => {
  test('CSP 放开 wasm 与字体，且不放开 https', () => {
    const html = renderHtml(input);
    expect(html).toContain("script-src 'nonce-n1' 'wasm-unsafe-eval'");
    expect(html).toContain('font-src vscode-resource://x');
    expect(html).toContain('nonce="n1"');
    expect(html).not.toContain('https:');
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
