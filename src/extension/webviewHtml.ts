export interface HtmlInput {
  /** webview.cspSource，用于放行本地资源。 */
  cspSource: string;
  scriptUri: string;
  styleUri: string;
  nonce: string;
}

function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * 生成 webview HTML。脚本与样式来自固定产物 dist/webview.js / dist/webview.css，
 * 不加载任何远程资源；CSP 只放行 webview 自身来源、nonce 脚本与 wasm。
 */
export function renderHtml(input: HtmlInput): string {
  const cspSource = escapeAttribute(input.cspSource);
  const nonce = escapeAttribute(input.nonce);
  const scriptUri = escapeAttribute(input.scriptUri);
  const styleUri = escapeAttribute(input.styleUri);

  const csp = [
    "default-src 'none'",
    `style-src ${cspSource} 'unsafe-inline'`,
    `font-src ${cspSource}`,
    `img-src ${cspSource} data: blob:`,
    `media-src ${cspSource}`,
    // blob: 用于 worker 内读取主线程预取的 wasm/字体 blob URL。
    `connect-src ${cspSource} blob:`,
    // worker 引擎用 createObjectURL(new Blob([...])) 创建 Worker，必须显式放行 blob:。
    // worker 继承本页 CSP，wasm-unsafe-eval 与 connect-src 会一并生效。
    `worker-src ${cspSource} blob:`,
    `script-src 'nonce-${nonce}' 'wasm-unsafe-eval'`,
  ].join('; ');

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<link rel="stylesheet" href="${styleUri}">
<title>PDF 预览</title>
</head>
<body>
<div id="root"></div>
<script type="module" nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}
