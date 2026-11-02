import { FontCharset } from '@embedpdf/models';
import { describe, expect, test } from 'vitest';
import { DISABLED_CATEGORIES, createViewerConfig } from '../src/webview/viewerConfig';

describe('DISABLED_CATEGORIES', () => {
  test('关闭写入类与文件类功能，且无重复', () => {
    const set = new Set(DISABLED_CATEGORIES);
    expect(set.size).toBe(DISABLED_CATEGORIES.length);
    // 写入类：批注、表单、涂黑、签名、印章，以及图片/附件插入。
    for (const name of ['annotation', 'form', 'redaction', 'signature', 'stamp', 'insert']) {
      expect(set.has(name)).toBe(true);
    }
    // 文件类：打印、导出/下载、截图、全屏、打开与关闭文件。
    for (const name of [
      'document-print',
      'document-export',
      'document-capture',
      'document-fullscreen',
      'document-open',
      'document-close',
    ]) {
      expect(set.has(name)).toBe(true);
    }
  });
});

describe('createViewerConfig', () => {
  const input = {
    theme: 'dark' as const,
    wasmUrl: 'vscode-resource://w/pdfium.wasm',
    fontBaseUrl: 'vscode-resource://f/',
  };

  test('配置固定项', () => {
    const config = createViewerConfig(input);
    expect(config.worker).toBe(false);
    expect(config.tabBar).toBe('never');
    expect(config.wasmUrl).toBe(input.wasmUrl);
    expect(config.disabledCategories).toEqual([...DISABLED_CATEGORIES]);
    expect(config.theme).toEqual({ preference: 'dark' });
  });

  test('渲染与预取参数：增大瓦片、预取一环并加深页面缓冲', () => {
    const config = createViewerConfig(input);
    expect(config.tiling).toEqual({ tileSize: 1024, extraRings: 1 });
    expect(config.scroll).toEqual({ defaultBufferSize: 6 });
    // viewportGap 只影响页间距，不是预取范围；包内没有 scroll prefetch gap 配置。
    expect(config.viewport).toBeUndefined();
  });

  test('worker:false 时运行时从 wasmUrl 取 media/pdfium.wasm，而非内联副本', () => {
    const config = createViewerConfig({
      ...input,
      wasmUrl: 'vscode-resource://w/dist/media/pdfium.wasm',
    });
    expect(config.worker).toBe(false);
    expect(config.wasmUrl).toBe('vscode-resource://w/dist/media/pdfium.wasm');
    expect(config.wasmUrl).toContain('/media/pdfium.wasm');
    expect(JSON.stringify(config)).not.toContain('data:application/wasm');
  });

  test('中文字体回退到本地 Noto Sans CJK', () => {
    const config = createViewerConfig(input);
    expect(config.fontFallback?.fonts?.[FontCharset.GB2312]).toEqual([
      { url: 'vscode-resource://f/NotoSansHans-Regular.otf', weight: 400 },
      { url: 'vscode-resource://f/NotoSansHans-Bold.otf', weight: 700 },
    ]);
    for (const charset of [FontCharset.CYRILLIC, FontCharset.GREEK, FontCharset.VIETNAMESE]) {
      expect(config.fontFallback?.fonts?.[charset]).toEqual([
        { url: 'vscode-resource://f/NotoSans-Regular.ttf', weight: 400 },
        { url: 'vscode-resource://f/NotoSans-Italic.ttf', weight: 400, italic: true },
        { url: 'vscode-resource://f/NotoSans-Bold.ttf', weight: 700 },
        { url: 'vscode-resource://f/NotoSans-BoldItalic.ttf', weight: 700, italic: true },
      ]);
    }
  });

  test('配置不含任何外部域名，界面字体与印章已关闭', () => {
    const config = createViewerConfig({ ...input, theme: 'light' });
    const text = JSON.stringify(config);
    expect(text).not.toMatch(/googleapis|gstatic|jsdelivr|unpkg|default-stamps/i);
    expect(text).not.toContain('http://');
    expect(text).not.toContain('https://');
    expect(config.fonts).toEqual({ ui: null, signature: null });
    expect(config.stamp).toEqual({ manifests: [] });
  });
});
