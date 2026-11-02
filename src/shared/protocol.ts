export type Theme = 'light' | 'dark';

export type HostToWebview =
  | { type: 'init'; uri: string; name: string; page: number; theme: Theme }
  | { type: 'document'; bytes: ArrayBuffer; page: number; revision: number }
  | { type: 'theme'; theme: Theme }
  | { type: 'error'; kind: 'read' | 'render'; message: string };

export type WebviewToHost =
  | { type: 'ready' }
  | { type: 'page'; page: number }
  | { type: 'retry' }
  | { type: 'error'; kind: 'read' | 'render'; message: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPageNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1;
}

/**
 * 严格校验 webview 发来的消息；未知字段可以存在，已知字段类型必须正确。
 */
export function isWebviewToHost(value: unknown): value is WebviewToHost {
  if (!isRecord(value)) {
    return false;
  }
  switch (value.type) {
    case 'ready':
    case 'retry':
      return true;
    case 'page':
      return isPageNumber(value.page);
    case 'error':
      return (value.kind === 'read' || value.kind === 'render') && typeof value.message === 'string';
    default:
      return false;
  }
}
