import { describe, expect, test, vi } from 'vitest';
import {
  applyNewDocument,
  type DocumentManagerCapability,
  type ScrollCapabilityLike,
} from '../src/webview/loadDocument';

interface LayoutEvent {
  documentId: string;
  isInitial: boolean;
  pageNumber: number;
  totalPages: number;
}

function setup(options: {
  totalPages?: number;
  openError?: Error;
  previous?: { documentId: string; page: number };
  targetPage?: number;
} = {}) {
  const calls: string[] = [];
  const totalPages = options.totalPages ?? 10;
  let layoutHandler: ((event: LayoutEvent) => void) | undefined;

  const scrollToPage = vi.fn(
    async ({ pageNumber }: { pageNumber: number; behavior: 'instant' }) => {
      calls.push(`scroll:${pageNumber}`);
    },
  );
  const scope = {
    getCurrentPage: vi.fn(() => 1),
    scrollToPage,
  };
  const forDocument = vi.fn(() => scope);
  const onLayoutReady = vi.fn((handler: (event: LayoutEvent) => void) => {
    layoutHandler = handler;
    return () => {
      layoutHandler = undefined;
    };
  });
  const scroll: ScrollCapabilityLike = { forDocument, onLayoutReady };

  const closeDocument = vi.fn((documentId: string) => {
    calls.push(`close:${documentId}`);
  });
  const manager: DocumentManagerCapability = {
    openDocumentBuffer: vi.fn(() => {
      calls.push('open');
      return {
        wait: async () => {
          if (options.openError) {
            throw options.openError;
          }
          layoutHandler?.({
            documentId: 'new',
            isInitial: true,
            pageNumber: 1,
            totalPages,
          });
          return { documentId: 'new' };
        },
      };
    }),
    closeDocument,
  };

  return { calls, manager, scroll, forDocument, scrollToPage, closeDocument, onLayoutReady };
}

describe('applyNewDocument', () => {
  test('成功后先跳页再关旧文档', async () => {
    const { calls, manager, scroll, scrollToPage } = setup({
      totalPages: 10,
      targetPage: 5,
      previous: { documentId: 'old', page: 3 },
    });
    await expect(
      applyNewDocument({
        bytes: new ArrayBuffer(8),
        name: 'a.pdf',
        targetPage: 5,
        manager,
        scroll,
        previous: { documentId: 'old', page: 3 },
      }),
    ).resolves.toEqual({ documentId: 'new' });

    expect(calls).toEqual(['open', 'scroll:5', 'close:old']);
    expect(scrollToPage).toHaveBeenCalledWith({ pageNumber: 5, behavior: 'instant' });
  });

  test('目标页超出页数时跳到末页', async () => {
    const { scrollToPage, manager, scroll } = setup({ totalPages: 3, targetPage: 9 });
    await applyNewDocument({
      bytes: new ArrayBuffer(8),
      name: 'a.pdf',
      targetPage: 9,
      manager,
      scroll,
    });
    expect(scrollToPage).toHaveBeenCalledWith({ pageNumber: 3, behavior: 'instant' });
  });

  test('打开失败抛错且不关闭旧文档', async () => {
    const { manager, scroll, closeDocument } = setup({
      openError: new Error('broken'),
      previous: { documentId: 'old', page: 3 },
    });
    await expect(
      applyNewDocument({
        bytes: new ArrayBuffer(8),
        name: 'a.pdf',
        targetPage: 5,
        manager,
        scroll,
        previous: { documentId: 'old', page: 3 },
      }),
    ).rejects.toThrow('broken');
    expect(closeDocument).not.toHaveBeenCalledWith('old');
    expect(closeDocument).not.toHaveBeenCalledWith('new');
  });

  test('零页文档视为失败', async () => {
    const { manager, scroll, closeDocument } = setup({
      totalPages: 0,
      targetPage: 2,
      previous: { documentId: 'old', page: 2 },
    });
    await expect(
      applyNewDocument({
        bytes: new ArrayBuffer(8),
        name: 'a.pdf',
        targetPage: 2,
        manager,
        scroll,
        previous: { documentId: 'old', page: 2 },
      }),
    ).rejects.toThrow();
    expect(closeDocument).toHaveBeenCalledWith('new');
  });

  test('wait 不返回 id 时退回随后的首屏 layout 事件', async () => {
    let layoutHandler: ((event: LayoutEvent) => void) | undefined;
    const scrollToPage = vi.fn(async () => undefined);
    const scroll: ScrollCapabilityLike = {
      onLayoutReady(handler) {
        layoutHandler = handler;
        return () => undefined;
      },
      forDocument: () => ({ getCurrentPage: () => 1, scrollToPage }),
    };
    const manager: DocumentManagerCapability = {
      openDocumentBuffer: () => ({
        wait: async () => {
          setTimeout(() => {
            layoutHandler?.({ documentId: 'new', isInitial: true, pageNumber: 1, totalPages: 4 });
          }, 0);
          return undefined;
        },
      }),
      closeDocument: vi.fn(),
    };

    await expect(
      applyNewDocument({
        bytes: new ArrayBuffer(8),
        name: 'a.pdf',
        targetPage: 2,
        manager,
        scroll,
      }),
    ).resolves.toEqual({ documentId: 'new' });
    expect(scrollToPage).toHaveBeenCalledWith({ pageNumber: 2, behavior: 'instant' });
  });

  test('没有旧文档时不调用 close', async () => {
    const { closeDocument, manager, scroll } = setup({ targetPage: 1 });
    await applyNewDocument({
      bytes: new ArrayBuffer(8),
      name: 'a.pdf',
      targetPage: 1,
      manager,
      scroll,
    });
    expect(closeDocument).not.toHaveBeenCalled();
  });
});
