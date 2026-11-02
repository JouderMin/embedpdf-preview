import { describe, expect, test, vi } from 'vitest';
import {
  applyNewDocument,
  type DocumentManagerCapability,
  type PdfTaskLike,
  type ScrollCapabilityLike,
} from '../src/webview/loadDocument';

interface LayoutEvent {
  documentId: string;
  isInitial: boolean;
  pageNumber: number;
  totalPages: number;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  const task: PdfTaskLike<T> = {
    toPromise: () => promise,
    wait: (onResolved, onRejected) => {
      promise.then(onResolved, (error) => onRejected({ type: 'reject', reason: error }));
    },
  };
  return { task, resolve, reject };
}

function resolved<T>(value: T): PdfTaskLike<T> {
  return {
    toPromise: () => Promise.resolve(value),
    wait: (onResolved) => onResolved(value),
  };
}

function rejected<T>(error: unknown): PdfTaskLike<T> {
  return {
    toPromise: () => Promise.reject(error),
    wait: (_onResolved, onRejected) => onRejected({ type: 'reject', reason: error }),
  };
}

function setup(
  options: {
    totalPages?: number;
    previous?: { documentId: string; page: number };
    autoLayout?: boolean;
    replayOld?: LayoutEvent;
    engineFailure?: string;
    documentError?: string;
    openFailure?: Error;
    scrollThrows?: boolean;
  } = {},
) {
  const calls: string[] = [];
  const totalPages = options.totalPages ?? 10;
  let layoutHandler: ((event: LayoutEvent) => void) | undefined;
  let documentErrorHandler: ((event: { documentId: string; message: string }) => void) | undefined;

  const scrollToPage = vi.fn(
    ({ pageNumber }: { pageNumber: number; behavior: 'instant' }) => {
      calls.push(`scroll:${pageNumber}`);
      if (options.scrollThrows) {
        throw new Error('scroll failed');
      }
    },
  );
  const scope = { getCurrentPage: vi.fn(() => 1), scrollToPage };
  const forDocument = vi.fn(() => scope);
  const onLayoutReady = vi.fn((handler: (event: LayoutEvent) => void) => {
    layoutHandler = handler;
    if (options.replayOld) {
      handler(options.replayOld);
    }
    return () => {
      layoutHandler = undefined;
    };
  });
  const scroll: ScrollCapabilityLike = { forDocument, onLayoutReady };

  const closeDocument = vi.fn((documentId: string) => {
    calls.push(`close:${documentId}`);
    return resolved<void>(undefined);
  });
  const engine = deferred<unknown>();
  const waitSpy = vi.fn();
  const openDocumentBuffer = vi.fn((): PdfTaskLike<{ documentId: string; task: PdfTaskLike<unknown> }> => {
    calls.push('open');
    if (options.openFailure) {
      return rejected(options.openFailure);
    }
    setTimeout(() => {
      if (options.autoLayout === false) {
        return;
      }
      layoutHandler?.({
        documentId: 'new',
        isInitial: true,
        pageNumber: 1,
        totalPages,
      });
    }, 0);
    if (options.documentError) {
      setTimeout(() => {
        documentErrorHandler?.({ documentId: 'new', message: options.documentError! });
      }, 0);
    }
    if (options.engineFailure) {
      setTimeout(() => {
        engine.reject(new Error(options.engineFailure));
      }, 0);
    }
    const responseTask: PdfTaskLike<{ documentId: string; task: PdfTaskLike<unknown> }> = {
      toPromise: () => Promise.resolve({ documentId: 'new', task: engine.task }),
      wait: (onResolved) => onResolved({ documentId: 'new', task: engine.task }),
    };
    waitSpy.mockImplementation(() => undefined);
    return responseTask;
  });
  const manager: DocumentManagerCapability = {
    openDocumentBuffer,
    closeDocument,
    onDocumentError(handler) {
      documentErrorHandler = handler;
      return () => {
        documentErrorHandler = undefined;
      };
    },
  };

  return {
    calls,
    manager,
    scroll,
    forDocument,
    scrollToPage,
    closeDocument,
    openDocumentBuffer,
    waitSpy,
  };
}

function apply(
  manager: DocumentManagerCapability,
  scroll: ScrollCapabilityLike,
  options: {
    previous?: { documentId: string; page: number };
    targetPage?: number;
  } = {},
) {
  return applyNewDocument({
    bytes: new ArrayBuffer(8),
    name: 'a.pdf',
    targetPage: options.targetPage ?? 5,
    manager,
    scroll,
    previous: options.previous,
  });
}

describe('applyNewDocument', () => {
  test('成功后先跳页再关旧文档，并使用真实 Task API', async () => {
    const { calls, manager, scroll, scrollToPage, openDocumentBuffer } = setup({
      totalPages: 10,
      previous: { documentId: 'old', page: 3 },
    });
    await expect(
      apply(manager, scroll, { previous: { documentId: 'old', page: 3 }, targetPage: 5 }),
    ).resolves.toEqual({ documentId: 'new', page: 5 });

    expect(calls).toEqual(['open', 'scroll:5', 'close:old']);
    expect(scrollToPage).toHaveBeenCalledWith({ pageNumber: 5, behavior: 'instant' });
    expect(openDocumentBuffer).toHaveBeenCalledTimes(1);
  });

  test('目标页超出页数时跳到末页，并回传夹取后的页码', async () => {
    const { scrollToPage, manager, scroll } = setup({ totalPages: 3 });
    await expect(apply(manager, scroll, { targetPage: 9 })).resolves.toEqual({
      documentId: 'new',
      page: 3,
    });
    expect(scrollToPage).toHaveBeenCalledWith({ pageNumber: 3, behavior: 'instant' });
  });

  test('订阅时重放旧文档的 layout 不会让新文档误用旧 id', async () => {
    const { calls, manager, scroll, closeDocument } = setup({
      totalPages: 10,
      previous: { documentId: 'old', page: 3 },
      replayOld: { documentId: 'old', isInitial: true, pageNumber: 3, totalPages: 10 },
    });
    await expect(
      apply(manager, scroll, { previous: { documentId: 'old', page: 3 }, targetPage: 4 }),
    ).resolves.toEqual({ documentId: 'new', page: 4 });
    expect(calls).toEqual(['open', 'scroll:4', 'close:old']);
    expect(closeDocument).toHaveBeenCalledTimes(1);
  });

  test('重放旧 layout 且新文档加载失败时不关闭旧文档', async () => {
    const { closeDocument, manager, scroll } = setup({
      previous: { documentId: 'old', page: 3 },
      replayOld: { documentId: 'old', isInitial: true, pageNumber: 3, totalPages: 10 },
      autoLayout: false,
      engineFailure: 'broken',
    });
    await expect(
      apply(manager, scroll, { previous: { documentId: 'old', page: 3 }, targetPage: 4 }),
    ).rejects.toThrow('broken');
    expect(closeDocument).toHaveBeenCalledWith('new');
    expect(closeDocument).not.toHaveBeenCalledWith('old');
  });

  test('engine task 拒绝时在超时前抛错并清理新文档', async () => {
    const { closeDocument, manager, scroll } = setup({
      previous: { documentId: 'old', page: 3 },
      autoLayout: false,
      engineFailure: 'encrypted',
    });
    const outcome = await Promise.race([
      apply(manager, scroll, { previous: { documentId: 'old', page: 3 } }).then(
        () => 'resolved',
        (error: Error) => error.message,
      ),
      new Promise<string>((resolve) => setTimeout(() => resolve('timeout'), 300)),
    ]);
    expect(outcome).toBe('encrypted');
    expect(closeDocument).toHaveBeenCalledWith('new');
    expect(closeDocument).not.toHaveBeenCalledWith('old');
  });

  test('documentError 事件同样终止等待并显示为加载失败', async () => {
    const { closeDocument, manager, scroll } = setup({
      autoLayout: false,
      documentError: '加密 PDF',
    });
    await expect(apply(manager, scroll)).rejects.toThrow('加密 PDF');
    expect(closeDocument).toHaveBeenCalledWith('new');
  });

  test('打开外层 Task 失败时抛错且不关闭任何文档', async () => {
    const { closeDocument, manager, scroll } = setup({
      openFailure: new Error('limit reached'),
      previous: { documentId: 'old', page: 3 },
    });
    await expect(
      apply(manager, scroll, { previous: { documentId: 'old', page: 3 } }),
    ).rejects.toThrow('limit reached');
    expect(closeDocument).not.toHaveBeenCalled();
  });

  test('零页文档视为失败并关闭新文档', async () => {
    const { closeDocument, manager, scroll } = setup({ totalPages: 0 });
    await expect(
      apply(manager, scroll, { previous: { documentId: 'old', page: 2 } }),
    ).rejects.toThrow('文档没有可显示的页面');
    expect(closeDocument).toHaveBeenCalledWith('new');
    expect(closeDocument).not.toHaveBeenCalledWith('old');
  });

  test('scrollToPage 失败时回滚新文档并保留旧文档', async () => {
    const { closeDocument, manager, scroll } = setup({
      scrollThrows: true,
      previous: { documentId: 'old', page: 3 },
    });
    await expect(
      apply(manager, scroll, { previous: { documentId: 'old', page: 3 } }),
    ).rejects.toThrow('scroll failed');
    expect(closeDocument).toHaveBeenCalledWith('new');
    expect(closeDocument).not.toHaveBeenCalledWith('old');
  });

  test('没有旧文档时不调用 close', async () => {
    const { closeDocument, manager, scroll } = setup();
    await expect(apply(manager, scroll, { targetPage: 1 })).resolves.toEqual({
      documentId: 'new',
      page: 1,
    });
    expect(closeDocument).not.toHaveBeenCalled();
  });
});
