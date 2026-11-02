import { access, copyFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

const WASM_SOURCE = 'node_modules/@embedpdf/pdfium/dist/pdfium.wasm';
const MEDIA_DIR = 'dist/media';
const FONT_OUT_DIR = path.join(MEDIA_DIR, 'fonts');
// 只带设计确认过的 6 款字体：简体常规/粗体，拉丁常规/斜体/粗体/粗斜体。
const FONT_FILES = [
  'node_modules/@embedpdf/fonts-sc/fonts/NotoSansHans-Regular.otf',
  'node_modules/@embedpdf/fonts-sc/fonts/NotoSansHans-Bold.otf',
  'node_modules/@embedpdf/fonts-latin/fonts/NotoSans-Regular.ttf',
  'node_modules/@embedpdf/fonts-latin/fonts/NotoSans-Italic.ttf',
  'node_modules/@embedpdf/fonts-latin/fonts/NotoSans-Bold.ttf',
  'node_modules/@embedpdf/fonts-latin/fonts/NotoSans-BoldItalic.ttf',
];

async function exists(target) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

const missing = [];
if (!(await exists(WASM_SOURCE))) {
  missing.push(WASM_SOURCE);
}
for (const font of FONT_FILES) {
  if (!(await exists(font))) {
    missing.push(font);
  }
}

if (missing.length > 0) {
  console.error('copy-assets: 缺少以下资源，请先运行 pnpm install：');
  for (const target of missing) {
    console.error(`  - ${target}`);
  }
  process.exit(1);
}

await mkdir(FONT_OUT_DIR, { recursive: true });
await copyFile(WASM_SOURCE, path.join(MEDIA_DIR, 'pdfium.wasm'));

for (const font of FONT_FILES) {
  await copyFile(font, path.join(FONT_OUT_DIR, path.basename(font)));
}

console.log(`copy-assets: pdfium.wasm 与 ${FONT_FILES.length} 个字体已复制到 ${MEDIA_DIR}`);
