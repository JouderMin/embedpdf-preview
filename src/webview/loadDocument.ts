import type { HostToWebview, WebviewToHost } from '../shared/protocol';

/**
 * `@embedpdf/models` 的 Task 最小真实形状：加载任务由 `toPromise()` 等待，
 * `wait()` 只接受两个回调。不要把 `wait()` 当成返回 Promise 的函数使用。
 */
export interface PdfTaskLike<R> {
  toPromise(): Promise<R>;
  wait(
    onResolved: (result: R) => void,
    onRejected: (error: { type: 'reject' | 'abort'; reason: unknown }) => void,
  ): void;
}

/** `DocumentManagerCapability` 中本文件用到的真实签名（见 plugin-document-manager）。 */
export interface DocumentManagerCapability {
  openDocumentBuffer(options: {
    buffer: ArrayBuffer;
    name: string;
    autoActivate: boolean;
  }): PdfTaskLike<{ documentId: string; task: PdfTaskLike<unknown> }>;
  closeDocument(documentId: string): PdfTaskLike<void>;
  onDocumentError?(
    handler: (event: { documentId: string; message: string }) => void,
  ): () => void;
}

export interface ScrollScopeLike {
  getCurrentPage(): number;
  getMetrics(): ScrollMetricsLike;
  scrollToPage(options: {
    pageNumber: number;
    behavior: 'instant';
    pageCoordinates?: { x: number; y: number };
  }): void;
}

/** scroll 插件 `getMetrics()` 中恢复阅读位置所需的最小字段。 */
export interface ScrollMetricsLike {
  currentPage: number;
  scrollOffset: { x: number; y: number };
  pageVisibilityMetrics: Array<{
    pageNumber: number;
    /** 可见交集顶点相对视口左侧/顶部的偏移（缩放后的像素）。 */
    viewportX: number;
    viewportY: number;
    scaled: {
      /** 可见交集顶点相对页左侧/顶部的偏移（缩放后的像素）。 */
      pageX: number;
      pageY: number;
      /** 页面实际渲染比例；优先用它换算像素偏移。 */
      scale: number;
    };
  }>;
}

export type ZoomLevel = number | 'automatic' | 'fit-page' | 'fit-width';

export interface ZoomStateLike {
  /** 用户选择的层级：数字是百分比式缩放，字符串是 fit 模式。 */
  zoomLevel: ZoomLevel;
  /** 当前实际缩放比例（fit 模式也算出的实际值）。 */
  currentZoomLevel: number;
}

export interface ZoomScopeLike {
  getState(): ZoomStateLike;
  requestZoom(level: ZoomLevel): void;
}

export interface ZoomCapabilityLike {
  forDocument(documentId: string): ZoomScopeLike;
}

/** 重载前要保留的阅读状态：页码、页内像素偏移、缩放层级。 */
export interface ViewState {
  page: number;
  /** 视口左侧相对页左的像素偏移。 */
  offsetX?: number;
  /** 视口顶部相对页顶的像素偏移；负数表示停在页间空隙。 */
  offsetY?: number;
  /** 实际渲染比例，优先取 metrics.scaled.scale，拿不到时回退 zoom.currentZoomLevel。 */
  scale?: number;
  zoom?: {
    level: ZoomLevel;
    /** 记录偏移时使用的实际比例，用于把像素换算成页坐标。 */
    scale: number;
  };
}

export interface PreviousViewState extends ViewState {
  documentId: string;
}

export interface ScrollCapabilityLike {
  forDocument(documentId: string): ScrollScopeLike;
  onLayoutReady(
    handler: (event: {
      documentId: string;
      isInitial: boolean;
      pageNumber: number;
      totalPages: number;
    }) => void,
  ): () => void;
}

export interface ApplyNewDocumentInput {
  bytes: ArrayBuffer;
  name: string;
  targetPage: number;
  manager: DocumentManagerCapability;
  scroll: ScrollCapabilityLike;
  zoom?: ZoomCapabilityLike;
  previous?: PreviousViewState;
  /** 等待新文档首屏布局的上限，防止损坏文档让界面永久挂起。 */
  layoutTimeoutMs?: number;
}

export interface ApplyNewDocumentResult {
  documentId: string;
  /** 实际跳转到的页码（目标页超过总页数时会夹取到末页）。 */
  page: number;
}

interface LayoutEvent {
  documentId: string;
  isInitial: boolean;
  pageNumber: number;
  totalPages: number;
}

function clampPage(targetPage: number, totalPages: number): number {
  const target = Number.isFinite(targetPage) ? Math.trunc(targetPage) : 1;
  return Math.max(1, Math.min(target, totalPages));
}

function taskErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (error && typeof error === 'object' && 'reason' in error) {
    const reason = (error as { reason: unknown }).reason;
    if (reason instanceof Error) {
      return reason.message;
    }
    if (typeof reason === 'string') {
      return reason;
    }
  }
  return String(error);
}

async function closeQuietly(
  manager: DocumentManagerCapability,
  documentId: string,
  label: string,
): Promise<void> {
  try {
    const closed = manager.closeDocument(documentId);
    if (closed && typeof closed.toPromise === 'function') {
      await closed.toPromise();
    }
  } catch (error) {
    console.warn(`${label}失败`, error);
  }
}

/**
 * 读取当前阅读状态。页内偏移用 scroll 的可见性 metrics 计算：
 * 视口顶相对页顶的像素 = scaled.pageY - viewportY。负数表示视口停在页间空隙。
 * 缩放同时记录“层级”（数字或 fit 模式）与“实际比例”，恢复时不能把 fit 当成固定百分比。
 */
export function captureViewState(
  scroll: ScrollCapabilityLike,
  zoom: ZoomCapabilityLike | undefined,
  documentId: string,
  fallbackPage: number,
): ViewState {
  let page = Number.isFinite(fallbackPage) && fallbackPage >= 1 ? Math.trunc(fallbackPage) : 1;
  let offsetX = 0;
  let offsetY = 0;
  let pageScale: number | undefined;

  try {
    const scope = scroll.forDocument(documentId);
    const current = scope.getCurrentPage();
    if (Number.isFinite(current) && current >= 1) {
      page = Math.trunc(current);
    }
    const metrics = scope.getMetrics();
    const visibility = metrics.pageVisibilityMetrics.find((item) => item.pageNumber === page);
    if (visibility) {
      const candidateX = visibility.scaled.pageX - visibility.viewportX;
      const candidateY = visibility.scaled.pageY - visibility.viewportY;
      if (Number.isFinite(candidateX)) {
        offsetX = candidateX;
      }
      if (Number.isFinite(candidateY)) {
        offsetY = candidateY;
      }
      if (Number.isFinite(visibility.scaled.scale) && visibility.scaled.scale > 0) {
        pageScale = visibility.scaled.scale;
      }
    }
  } catch {
    // 读取位置失败时退化为“页首”，不影响重载本身。
  }

  let zoomState: ViewState['zoom'];
  try {
    const state = zoom?.forDocument(documentId).getState();
    if (
      state &&
      typeof state.zoomLevel !== 'undefined' &&
      Number.isFinite(state.currentZoomLevel) &&
      state.currentZoomLevel > 0
    ) {
      zoomState = { level: state.zoomLevel, scale: state.currentZoomLevel };
    }
  } catch {
    // 缩放插件不可用或状态未就绪时只恢复页码。
  }

  // R12-1：metrics 的页面实际比例优先；zoom.currentZoomLevel 只在拿不到时兜底。
  const scale = pageScale ?? zoomState?.scale;
  if (zoomState && scale !== undefined) {
    zoomState = { ...zoomState, scale };
  }

  return { page, offsetX, offsetY, scale, zoom: zoomState };
}

/**
 * 加载一份新文档并回到原页。顺序：打开 → 等新文档首屏布局 → 恢复缩放 →
 * 按页内偏移跳页 → 关闭旧文档。任何一步失败都关闭新文档、保留旧文档。
 *
 * 注意两点：
 * - `openDocumentBuffer` 返回的外层 Task 只表示“已开始加载”，必须等其中的
 *   `task`（engineTask）或 `onDocumentError` 才能知道真实加载结果。
 * - layoutReady 是 behavior emitter，订阅时会重放旧文档最后一条事件；因此
 *   所有缓冲和等待都按新 documentId 过滤。
 */
export async function applyNewDocument(
  input: ApplyNewDocumentInput,
): Promise<ApplyNewDocumentResult> {
  const buffered: LayoutEvent[] = [];
  const documentErrors = new Map<string, string>();
  let newDocumentId: string | undefined;
  let waiter: { documentId: string; resolve: (event: LayoutEvent) => void } | undefined;
  let failForDocument: ((documentId: string, message: string) => void) | undefined;

  const unsubscribeLayout = input.scroll.onLayoutReady((event) => {
    if (!event.isInitial) {
      return;
    }
    buffered.push(event);
    if (waiter && event.documentId === waiter.documentId) {
      const pending = waiter;
      waiter = undefined;
      pending.resolve(event);
    }
  });

  const unsubscribeError = input.manager.onDocumentError?.((event) => {
    documentErrors.set(event.documentId, event.message);
    failForDocument?.(event.documentId, event.message);
  });

  const waitForLayout = (documentId: string): Promise<LayoutEvent> => {
    const existing = buffered.find((event) => event.documentId === documentId);
    if (existing) {
      return Promise.resolve(existing);
    }
    return new Promise((resolve) => {
      waiter = { documentId, resolve };
    });
  };

  try {
    const response = await input.manager
      .openDocumentBuffer({
        buffer: input.bytes,
        name: input.name,
        autoActivate: true,
      })
      .toPromise();

    newDocumentId = response.documentId;
    if (typeof newDocumentId !== 'string' || newDocumentId.length === 0) {
      throw new Error('打开文档后没有返回 documentId');
    }

    const loadFailure = new Promise<never>((_resolve, reject) => {
      const fail = (message: string) => {
        reject(new Error(message));
      };
      failForDocument = (documentId, message) => {
        if (documentId === newDocumentId) {
          fail(message);
        }
      };
      const existing = documentErrors.get(newDocumentId!);
      if (existing !== undefined) {
        fail(existing);
        return;
      }
      response.task.toPromise().catch((error) => {
        fail(taskErrorMessage(error));
      });
    });

    const layoutPromise = waitForLayout(newDocumentId);
    const timeoutMs = input.layoutTimeoutMs ?? 10_000;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        reject(new Error(`等待文档布局超时（${timeoutMs}ms）`));
      }, timeoutMs);
    });

    let layout: LayoutEvent;
    try {
      layout = await Promise.race([layoutPromise, loadFailure, timeoutPromise]);
    } finally {
      if (timeout !== undefined) {
        clearTimeout(timeout);
      }
      failForDocument = undefined;
    }

    if (layout.totalPages <= 0) {
      throw new Error('文档没有可显示的页面');
    }

    const page = clampPage(input.targetPage, layout.totalPages);
    const scrollScope = input.scroll.forDocument(newDocumentId);
    const previous = input.previous;

    // 先恢复缩放：scrollToPage 的 pageCoordinates 会按当前 coreDoc.scale 缩放。
    if (previous?.zoom && input.zoom) {
      try {
        input.zoom.forDocument(newDocumentId).requestZoom(previous.zoom.level);
      } catch (error) {
        console.warn('恢复缩放失败', error);
      }
    }

    const hasOffsetX = typeof previous?.offsetX === 'number';
    const hasOffsetY = typeof previous?.offsetY === 'number';
    const offsetX =
      hasOffsetX && Number.isFinite(previous.offsetX) ? (previous.offsetX as number) : 0;
    const offsetY =
      hasOffsetY && Number.isFinite(previous.offsetY) ? (previous.offsetY as number) : 0;
    const recordedScale = previous?.scale ?? previous?.zoom?.scale;
    const scale =
      typeof recordedScale === 'number' && Number.isFinite(recordedScale) && recordedScale > 0
        ? recordedScale
        : 1;
    scrollScope.scrollToPage({
      pageNumber: page,
      behavior: 'instant',
      // pageCoordinates 是未缩放的页坐标；把像素偏移换算回页坐标，恢复时再乘新比例。
      ...(hasOffsetX || hasOffsetY
        ? { pageCoordinates: { x: offsetX / scale, y: offsetY / scale } }
        : {}),
    });

    if (input.previous) {
      await closeQuietly(input.manager, input.previous.documentId, '关闭旧文档');
    }

    return { documentId: newDocumentId, page };
  } catch (error) {
    if (newDocumentId) {
      await closeQuietly(input.manager, newDocumentId, '回滚新文档');
    }
    throw error;
  } finally {
    failForDocument = undefined;
    unsubscribeLayout();
    unsubscribeError?.();
  }
}

/** webview 向扩展发消息。桥接层在 bridge.ts 中实现。 */
export type PostToHost = (message: WebviewToHost) => void;

/** 订阅扩展消息。桥接层在 bridge.ts 中实现。 */
export type SubscribeHost = (handler: (message: HostToWebview) => void) => () => void;
