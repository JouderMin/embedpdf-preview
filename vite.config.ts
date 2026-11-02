import { fileURLToPath } from 'node:url';
import { transform } from 'esbuild';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

const entry = fileURLToPath(new URL('src/webview/main.tsx', import.meta.url));

/**
 * Vite 6 的 ES lib 构建固定 `minifyWhitespace=false`（`resolveEsbuildTranspileOptions`），
 * 即使 `build.minify` 与 `esbuild.minifyWhitespace` 都打开也只会压标识符与语法。
 * 这里在 bundle 生成后再做一次完整 esbuild minify，保留固定文件名与输出目录。
 */
function minifyWebviewBundle(): Plugin {
  return {
    name: 'minify-webview-bundle',
    apply: 'build',
    enforce: 'post',
    async generateBundle(_options, bundle) {
      for (const output of Object.values(bundle)) {
        if (output.type !== 'chunk' || output.fileName !== 'webview.js') {
          continue;
        }
        const result = await transform(output.code, {
          loader: 'js',
          format: 'esm',
          target: 'es2022',
          minify: true,
          legalComments: 'none',
        });
        output.code = result.code;
      }
    },
  };
}

/**
 * 需要改写的模块：`@embedpdf/pdfium/dist/index.browser.js`，以及 snippet 自带的
 * `@embedpdf/snippet/dist/direct-engine-*.js` 与 `worker-engine-*.js`。这些胶水
 * 里都有 `new URL('pdfium.wasm', import.meta.url)`，Vite lib 模式会把它内联成
 * 6.2 MB 的 base64 data URL；该分支只在 worker 引擎路径被引用，而本项目固定
 * `worker:false`，运行时始终通过 wasmUrl 读取 dist/media/pdfium.wasm。这里只改写
 * URL，不删除任何模块，也不会动 media/pdfium.wasm 本体。
 */
function externalizePdfiumWasm(): Plugin {
  // 两处来源：@embedpdf/pdfium 的浏览器胶水，以及 snippet 自带的 direct/worker
  // engine 打包文件（worker:false 时它们不会执行）。
  const wasmUrlPattern =
    /new URL\(\s*(['"])pdfium\.wasm\1\s*,\s*import\.meta\.url\s*\)/g;
  return {
    name: 'externalize-pdfium-wasm',
    apply: 'build',
    enforce: 'pre',
    transform(code, id) {
      const fromPdfium = id.includes('@embedpdf/pdfium') && /\/dist\/index(?:\.browser)?\.js$/.test(id);
      const fromSnippetEngine =
        id.includes('@embedpdf/snippet/dist/') && /(?:direct|worker)-engine-[^/]+\.js$/.test(id);
      if ((!fromPdfium && !fromSnippetEngine) || !code.includes('pdfium.wasm')) {
        return null;
      }
      const next = code.replace(wasmUrlPattern, "new URL(/* @vite-ignore */ './media/pdfium.wasm', import.meta.url)");
      return next === code ? null : { code: next, map: null };
    },
  };
}

// 输出固定文件名：扩展端在运行时用 URI 拼资源地址，读不到带哈希的名字。
// 用 lib 模式 + rollup input，不产出 HTML；HTML 由 src/extension/webviewHtml.ts 生成。
export default defineConfig({
  plugins: [externalizePdfiumWasm(), react(), minifyWebviewBundle()],
  build: {
    outDir: 'dist',
    // dist/extension.js 由 esbuild 先写入，Vite 不得清空目录。
    emptyOutDir: false,
    target: 'es2022',
    cssCodeSplit: false,
    minify: 'esbuild',
    lib: {
      entry,
      formats: ['es'],
      fileName: () => 'webview.js',
      cssFileName: 'webview',
    },
    rollupOptions: {
      input: entry,
      // 扩展只加载 dist/webview.js 一个 URL；任何动态分块都会因 CSP/nonce
      // 与固定文件名约定而无法加载，所以强制内联进单文件。
      output: { inlineDynamicImports: true },
    },
  },
});
