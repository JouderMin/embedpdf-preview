export type Theme = 'light' | 'dark';

/** zoom 插件的真实层级；包内没有 fit-height。 */
export type ZoomMode = 'automatic' | 'fit-page' | 'fit-width' | 'numeric';

export interface PersistedZoom {
  mode: ZoomMode;
  /** numeric 时是缩放比例；fit 模式时记录当时的实际比例，仅作兜底。 */
  level: number;
}

/** 写入 globalState 的完整阅读状态。键仍是 `embedpdf.page.<uri>`。 */
export interface PersistedViewState {
  v: 1;
  page: number;
  /** 页坐标（已除以缩放比例），与 scrollToPage 的 pageCoordinates 同单位。 */
  x: number;
  y: number;
  zoom?: PersistedZoom;
}

export type HostToWebview =
  | {
      type: 'init';
      uri: string;
      name: string;
      page: number;
      viewState: PersistedViewState;
      theme: Theme;
    }
  | {
      type: 'document';
      bytes: ArrayBuffer;
      page: number;
      viewState: PersistedViewState;
      revision: number;
    }
  | { type: 'theme'; theme: Theme }
  | { type: 'error'; kind: 'read' | 'render'; message: string };

export type WebviewToHost =
  | { type: 'ready' }
  | { type: 'page'; page: number }
  | {
      type: 'viewState';
      page: number;
      x: number;
      y: number;
      zoom: PersistedZoom;
    }
  | { type: 'retry' }
  | { type: 'error'; kind: 'read' | 'render'; message: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPageNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isZoomMode(value: unknown): value is ZoomMode {
  return (
    value === 'automatic' || value === 'fit-page' || value === 'fit-width' || value === 'numeric'
  );
}

export function isPersistedZoom(value: unknown): value is PersistedZoom {
  return (
    isRecord(value) &&
    isZoomMode(value.mode) &&
    isFiniteNumber(value.level) &&
    value.level > 0
  );
}

export function isPersistedViewState(value: unknown): value is PersistedViewState {
  return (
    isRecord(value) &&
    value.v === 1 &&
    isPageNumber(value.page) &&
    isFiniteNumber(value.x) &&
    isFiniteNumber(value.y) &&
    (value.zoom === undefined || isPersistedZoom(value.zoom))
  );
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
    case 'viewState':
      return (
        isPageNumber(value.page) &&
        isFiniteNumber(value.x) &&
        isFiniteNumber(value.y) &&
        isPersistedZoom(value.zoom)
      );
    case 'error':
      return (value.kind === 'read' || value.kind === 'render') && typeof value.message === 'string';
    default:
      return false;
  }
}
