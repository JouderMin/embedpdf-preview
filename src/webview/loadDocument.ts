import type { HostToWebview, WebviewToHost } from '../shared/protocol';

export interface DocumentManagerCapability {
  openDocumentBuffer(options: {
    buffer: ArrayBuffer;
    name: string;
    autoActivate: boolean;
  }): { wait(): Promise<unknown> };
  closeDocument(documentId: string): void;
}

export interface ScrollScopeLike {
  getCurrentPage(): number;
  scrollToPage(options: { pageNumber: number; behavior: 'instant' }): Promise<void>;
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
}

interface LayoutEvent {
  documentId: string;
  isInitial: boolean;
  pageNumber: number;
  totalPages: number;
}

function documentIdOf(response: unknown): string | undefined {
  if (typeof response === 'string') {
    return response;
  }
  if (response && typeof response === 'object') {
    const id = (response as { documentId?: unknown }).documentId;
    if (typeof id === 'string' && id.length > 0) {
      return id;
    }
  }
  return undefined;
}

function clampPage(targetPage: number, totalPages: number): number {
  const target = Number.isFinite(targetPage) ? Math.trunc(targetPage) : 1;
  return Math.max(1, Math.min(target, totalPages));
}

/**
 * 加载一份新文档并回到原页。顺序：订阅 layout → 打开 → 等首屏 layout →
 * 跳到目标页 → 关闭旧文档。任何一步失败都关闭新文档并让旧文档保持激活。
 */
export async function applyNewDocument(
  input: ApplyNewDocumentInput,
): Promise<{ documentId: string }> {
  const buffered: LayoutEvent[] = [];
  let newDocumentId: string | undefined;
  let waiter:
    | { documentId?: string; resolve: (event: LayoutEvent) => void }
    | undefined;

  const unsubscribe = input.scroll.onLayoutReady((event) => {
    if (!event.isInitial) {
      return;
    }
    // 先入缓冲再唤醒：即使 layout 事件早于 wait() 返回，也能被后续查找命中。
    buffered.push(event);
    if (waiter && (!waiter.documentId || event.documentId === waiter.documentId)) {
      const pending = waiter;
      waiter = undefined;
      pending.resolve(event);
    }
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
    const task = input.manager.openDocumentBuffer({
      buffer: input.bytes,
      name: input.name,
      autoActivate: true,
    });
    const response = await task.wait();
    newDocumentId = documentIdOf(response);

    // 真实 API 的 wait() 返回 { documentId }，但计划里的最小接口允许返回
    // unknown；没有 documentId 时退回本次打开产生的首个首屏 layout 事件。
    let layout: LayoutEvent | undefined;
    if (!newDocumentId) {
      const firstLayout =
        buffered[buffered.length - 1] ??
        (await new Promise<LayoutEvent>((resolve) => {
          waiter = { resolve };
        }));
      newDocumentId = firstLayout.documentId;
      layout = firstLayout;
    } else {
      layout = buffered.find((event) => event.documentId === newDocumentId);
      if (!layout) {
        layout = await waitForLayout(newDocumentId);
      }
    }

    if (!layout || layout.totalPages <= 0) {
      throw new Error('文档没有可显示的页面');
    }

    const pageNumber = clampPage(input.targetPage, layout.totalPages);
    await input.scroll
      .forDocument(newDocumentId)
      .scrollToPage({ pageNumber, behavior: 'instant' });

    if (input.previous) {
      try {
        input.manager.closeDocument(input.previous.documentId);
      } catch (error) {
        console.warn('关闭旧文档失败', error);
      }
    }

    return { documentId: newDocumentId };
  } catch (error) {
    if (newDocumentId) {
      try {
        input.manager.closeDocument(newDocumentId);
      } catch (closeError) {
        console.warn('回滚新文档失败', closeError);
      }
    }
    if (input.previous) {
      try {
        await input.scroll
          .forDocument(input.previous.documentId)
          .scrollToPage({ pageNumber: input.previous.page, behavior: 'instant' });
      } catch {
        // 旧文档可能已经不可用；保留它原来的激活状态即可。
      }
    }
    throw error;
  } finally {
    unsubscribe();
  }
}

/** webview 向扩展发消息。桥接层在 bridge.ts 中实现。 */
export type PostToHost = (message: WebviewToHost) => void;

/** 订阅扩展消息。桥接层在 bridge.ts 中实现。 */
export type SubscribeHost = (handler: (message: HostToWebview) => void) => () => void;
