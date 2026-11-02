/**
 * EmbedPDF 预览配置。包内事实（pnpm 2.15.1）：
 *
 * - `PDFViewerConfig` 由 `@embedpdf/react-pdf-viewer` 转出 `@embedpdf/snippet`；
 *   类型定义见 `.pnpm/@embedpdf+snippet@2.15.1_.../node_modules/@embedpdf/snippet/dist/components/app.d.ts`。
 *   `theme` 形状是 `{ preference?: 'light' | 'dark' | 'system' }`（`dist/config/theme.d.ts`），
 *   不是 `{ colorScheme }`。
 * - `fonts?: { ui?: SnippetUiFontConfig | null; signature?: ... | null }`；传 `null` 可跳过
 *   Google Fonts 样式表，`undefined` 会加载 `fonts.googleapis.com`。
 * - `stamp.manifests?: StampManifestSource[]`（`@embedpdf/plugin-stamp/dist/lib/types.d.ts`），
 *   传空数组可避免默认印章清单的外网请求。
 * - `FontFallbackConfig.fonts` 的键是 `FontCharset` 数字枚举，不是字符串：
 *   `GB2312 = 134`、`GREEK = 161`、`VIETNAMESE = 163`、`CYRILLIC = 204`
 *   （`@embedpdf/models/dist/pdf.d.ts:2182`）。因此这里用计算键 `[FontCharset.GB2312]`；
 *   若写成字符串键 `GB2312`，运行时 `fonts[charset]` 查不到。
 * - 引擎只在 URL 不以 `http://`、`https://`、`/` 开头时才拼 `fontFallback.baseUrl`
 *   （`@embedpdf/engines/dist/lib/pdfium/font-fallback.js`）。这里直接给绝对
 *   webview URI，并省略 `baseUrl`，避免 `vscode-resource://` 被重复前缀。
 *
 * `disabledCategories` 的合法值来自命令与 UI schema 的实际分类标签
 * （`@embedpdf/snippet/dist/embedpdf-*.js` 内 `categories:[...]`）。命令只要命中任一
 * 被禁分类即禁用，见 `@embedpdf/plugin-commands/dist/index.js`：
 * `command.categories.some((cat) => disabledCategories.includes(cat))`。
 * 设计第 5.5 节的抽象名对应到实际标签：
 *   annotation → `annotation`；form → `form`；redaction → `redaction`；
 *   signature → `signature` + `insert`；stamp → `stamp` + `insert`；
 *   print → `document-print`；export/download → `document-export`；
 *   attachment → `insert`；fullscreen → `document-fullscreen`；
 *   打开文件 → `document-open`；关闭文件 → `document-close`（打开被禁用后必须保留文档）。
 */
import { FontCharset } from '@embedpdf/models';
import type { PDFViewerConfig } from '@embedpdf/react-pdf-viewer';

export const DISABLED_CATEGORIES: readonly string[] = [
  'annotation',
  'form',
  'redaction',
  'signature',
  'stamp',
  'insert',
  'document-print',
  'document-export',
  'document-capture',
  'document-fullscreen',
  'document-open',
  'document-close',
];

export interface ViewerConfigInput {
  theme: 'light' | 'dark';
  wasmUrl: string;
  fontBaseUrl: string;
}

function fontUrl(base: string, name: string): string {
  return `${base.endsWith('/') ? base : `${base}/`}${name}`;
}

const LATIN_FONTS = [
  { file: 'NotoSans-Regular.ttf', weight: 400, italic: false },
  { file: 'NotoSans-Italic.ttf', weight: 400, italic: true },
  { file: 'NotoSans-Bold.ttf', weight: 700, italic: false },
  { file: 'NotoSans-BoldItalic.ttf', weight: 700, italic: true },
] as const;

export function createViewerConfig(input: ViewerConfigInput): PDFViewerConfig {
  const latinFonts = LATIN_FONTS.map(({ file, weight, italic }) => ({
    url: fontUrl(input.fontBaseUrl, file),
    weight,
    ...(italic ? { italic: true } : {}),
  }));

  return {
    worker: false,
    tabBar: 'never',
    wasmUrl: input.wasmUrl,
    theme: { preference: input.theme },
    disabledCategories: [...DISABLED_CATEGORIES],
    fonts: { ui: null, signature: null },
    stamp: { manifests: [] },
    fontFallback: {
      fonts: {
        [FontCharset.GB2312]: [
          { url: fontUrl(input.fontBaseUrl, 'NotoSansHans-Regular.otf'), weight: 400 },
          { url: fontUrl(input.fontBaseUrl, 'NotoSansHans-Bold.otf'), weight: 700 },
        ],
        [FontCharset.CYRILLIC]: latinFonts,
        [FontCharset.GREEK]: latinFonts,
        [FontCharset.VIETNAMESE]: latinFonts,
      },
    },
  };
}
