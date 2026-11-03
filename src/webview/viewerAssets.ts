import { FONT_FILES } from './viewerConfig';

const WASM_URL = new URL(/* @vite-ignore */ './media/pdfium.wasm', import.meta.url).toString();
const FONT_BASE_URL = new URL(/* @vite-ignore */ './media/fonts/', import.meta.url).toString();

export interface ViewerAssets {
  /** 预取后的 pdfium.wasm blob URL。worker 里 fetch webview 资源会超时，不能直接用资源 URL。 */
  wasmUrl: string;
  /** 字体文件名 → blob URL。 */
  fontUrls: Record<string, string>;
}

function mimeOfFont(file: string): string {
  return file.endsWith('.otf') ? 'font/otf' : 'font/ttf';
}

async function prefetch(url: string, type: string, signal?: AbortSignal): Promise<string> {
  const response = await fetch(url, { signal });
  if (!response.ok) {
    throw new Error(`加载资源失败：${url}（HTTP ${response.status}）`);
  }
  // 直接取 Blob，避免把 4.6 MB wasm / 数 MB 字体再复制进 JS 堆。
  const blob = await response.blob();
  return URL.createObjectURL(blob.type === type ? blob : blob.slice(0, blob.size, type));
}

/**
 * 在主线程把所有引擎资源读成 blob URL。
 *
 * worker 引擎会在 Worker 里 fetch wasmUrl 与 fontFallback 字体；webview 的
 * service worker 无法把 blob worker 关联回 webview id，这类请求会一直等到超时，
 * 返回正文 "Request Timeout"，随后被当作 wasm 字节编译并报
 * `expected magic word 00 61 73 6d, found 52 65 71 75`。blob URL 不经过网络与
 * service worker，worker 内可以正常读取。
 */
export async function prepareViewerAssets(signal?: AbortSignal): Promise<ViewerAssets> {
  const created: string[] = [];
  try {
    // wasm 与字体并行预取；字体最多 6 个，全部并发读取。
    const [wasmResult, ...fontResults] = await Promise.allSettled([
      prefetch(WASM_URL, 'application/wasm', signal),
      ...FONT_FILES.map((file) =>
        prefetch(new URL(file, FONT_BASE_URL).toString(), mimeOfFont(file), signal),
      ),
    ]);
    if (wasmResult.status === 'rejected') {
      throw wasmResult.reason;
    }
    created.push(wasmResult.value);
    const fontUrls: Record<string, string> = {};
    let failure: unknown;
    fontResults.forEach((result, index) => {
      if (result.status === 'fulfilled') {
        created.push(result.value);
        fontUrls[FONT_FILES[index]] = result.value;
      } else {
        failure ??= result.reason;
      }
    });
    if (failure !== undefined) {
      throw failure;
    }
    return { wasmUrl: wasmResult.value, fontUrls };
  } catch (error) {
    for (const url of created) {
      URL.revokeObjectURL(url);
    }
    throw error;
  }
}

export function releaseViewerAssets(assets: ViewerAssets): void {
  URL.revokeObjectURL(assets.wasmUrl);
  for (const url of Object.values(assets.fontUrls)) {
    URL.revokeObjectURL(url);
  }
}
