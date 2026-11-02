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
  scrollToPage(options: { pageNumber: number; behavior: 'instant' }): void;
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
  previous?: { documentId: string; page: number };
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
 * 加载一份新文档并回到原页。顺序：打开 → 等新文档首屏布局 → 跳到目标页 →
 * 关闭旧文档。任何一步失败都关闭新文档、保留旧文档。
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
    input.scroll.forDocument(newDocumentId).scrollToPage({ pageNumber: page, behavior: 'instant' });

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
