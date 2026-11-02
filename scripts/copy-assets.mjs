import { access, copyFile, mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';

const WASM_SOURCE = 'node_modules/@embedpdf/pdfium/dist/pdfium.wasm';
const FONT_DIRS = ['node_modules/@embedpdf/fonts-sc', 'node_modules/@embedpdf/fonts-latin'];
const MEDIA_DIR = 'dist/media';
const FONT_OUT_DIR = path.join(MEDIA_DIR, 'fonts');
const FONT_EXTENSIONS = new Set(['.otf', '.ttf']);

async function exists(target) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

async function collectFonts(dir) {
  if (!(await exists(dir))) {
    return { missing: [dir], fonts: [] };
  }
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  const fonts = entries
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(entry.parentPath ?? entry.path, entry.name))
    .filter((file) => FONT_EXTENSIONS.has(path.extname(file).toLowerCase()));
  return { missing: [], fonts };
}

const missing = [];
if (!(await exists(WASM_SOURCE))) {
  missing.push(WASM_SOURCE);
}

const fonts = [];
for (const dir of FONT_DIRS) {
  const result = await collectFonts(dir);
  missing.push(...result.missing);
  fonts.push(...result.fonts);
}

if (missing.length > 0) {
  console.error('copy-assets: 缺少以下资源，请先运行 npm install：');
  for (const target of missing) {
    console.error(`  - ${target}`);
  }
  process.exit(1);
}

await mkdir(FONT_OUT_DIR, { recursive: true });
await copyFile(WASM_SOURCE, path.join(MEDIA_DIR, 'pdfium.wasm'));

for (const font of fonts) {
  await copyFile(font, path.join(FONT_OUT_DIR, path.basename(font)));
}

console.log(`copy-assets: pdfium.wasm 与 ${fonts.length} 个字体已复制到 ${MEDIA_DIR}`);
