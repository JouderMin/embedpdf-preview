import type { HostToWebview, Theme, WebviewToHost } from '../shared/protocol';

interface VsCodeApi {
  postMessage(message: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

let api: VsCodeApi | undefined;

function getApi(): VsCodeApi {
  if (!api) {
    api = acquireVsCodeApi();
  }
  return api;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isTheme(value: unknown): value is Theme {
  return value === 'light' || value === 'dark';
}

function isHostToWebview(value: unknown): value is HostToWebview {
  if (!isRecord(value)) {
    return false;
  }
  switch (value.type) {
    case 'init':
      return (
        typeof value.uri === 'string' &&
        typeof value.name === 'string' &&
        typeof value.page === 'number' &&
        isTheme(value.theme)
      );
    case 'document':
      return (
        value.bytes instanceof ArrayBuffer &&
        typeof value.page === 'number' &&
        typeof value.revision === 'number'
      );
    case 'theme':
      return isTheme(value.theme);
    case 'error':
      return (
        (value.kind === 'read' || value.kind === 'render') && typeof value.message === 'string'
      );
    default:
      return false;
  }
}

/** 发消息给扩展。webview 未获得 API 时静默忽略（例如测试环境）。 */
export function postToHost(message: WebviewToHost): void {
  try {
    getApi().postMessage(message);
  } catch (error) {
    console.error('无法向扩展发送消息', error);
  }
}

/** 订阅扩展消息；返回退订函数。 */
export function onHostMessage(handler: (message: HostToWebview) => void): () => void {
  const listener = (event: MessageEvent) => {
    if (isHostToWebview(event.data)) {
      handler(event.data);
    }
  };
  window.addEventListener('message', listener);
  return () => window.removeEventListener('message', listener);
}
