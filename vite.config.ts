import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const entry = fileURLToPath(new URL('src/webview/main.tsx', import.meta.url));

// 输出固定文件名：扩展端在运行时用 URI 拼资源地址，读不到带哈希的名字。
// 用 lib 模式 + rollup input，不产出 HTML；HTML 由 src/extension/webviewHtml.ts 生成。
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
    // dist/extension.js 由 esbuild 先写入，Vite 不得清空目录。
    emptyOutDir: false,
    target: 'es2022',
    cssCodeSplit: false,
    lib: {
      entry,
      formats: ['es'],
      fileName: () => 'webview.js',
      cssFileName: 'webview',
    },
    rollupOptions: {
      input: entry,
    },
  },
});
