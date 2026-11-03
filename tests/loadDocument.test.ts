import { describe, expect, test, vi } from 'vitest';
import {
  applyNewDocument,
  captureViewState,
  fromPersistedViewState,
  toPersistedViewState,
  type DocumentManagerCapability,
  type PdfTaskLike,
  type ScrollCapabilityLike,
  type ScrollMetricsLike,
  type ViewState,
  type ZoomCapabilityLike,
  type ZoomLevel,
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
    currentPage?: number;
    metrics?: ScrollMetricsLike;
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
  const currentPage = options.currentPage ?? 1;
  const metrics: ScrollMetricsLike = options.metrics ?? {
    currentPage,
    scrollOffset: { x: 0, y: 0 },
    pageVisibilityMetrics: [
      {
        pageNumber: currentPage,
        viewportX: 0,
        viewportY: 0,
        scaled: { pageX: 0, pageY: 0, scale: 1 },
      },
    ],
  };
  let layoutHandler: ((event: LayoutEvent) => void) | undefined;
  let documentErrorHandler: ((event: { documentId: string; message: string }) => void) | undefined;

  const scrollToPage = vi.fn(
    (scrollOptions: {
      pageNumber: number;
      behavior: 'instant';
      pageCoordinates?: { x: number; y: number };
    }) => {
      calls.push(`scroll:${scrollOptions.pageNumber}`);
      if (options.scrollThrows) {
        throw new Error('scroll failed');
      }
    },
  );
  const scope = {
    getCurrentPage: vi.fn(() => currentPage),
    getMetrics: vi.fn(() => metrics),
    scrollToPage,
  };
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

function setupZoom(level: ZoomLevel = 1, scale = 1) {
  const requestZoom = vi.fn();
  const getState = vi.fn(() => ({ zoomLevel: level, currentZoomLevel: scale }));
  const scope = { getState, requestZoom };
  const forDocument = vi.fn(() => scope);
  const zoom: ZoomCapabilityLike = { forDocument };
  return { zoom, requestZoom, getState, forDocument };
}

function apply(
  manager: DocumentManagerCapability,
  scroll: ScrollCapabilityLike,
  options: {
    previous?: ViewState & { documentId: string };
    restore?: ViewState;
    targetPage?: number;
    zoom?: ZoomCapabilityLike;
  } = {},
) {
  return applyNewDocument({
    bytes: new ArrayBuffer(8),
    name: 'a.pdf',
    targetPage: options.targetPage ?? 5,
    manager,
    scroll,
    zoom: options.zoom,
    previous: options.previous,
    restore: options.restore,
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

describe('重载后的缩放与页内位置', () => {
  test('captureViewState 区分 fit 模式与数字比例', () => {
    const metrics: ScrollMetricsLike = {
      currentPage: 2,
      scrollOffset: { x: 0, y: 0 },
      pageVisibilityMetrics: [
        { pageNumber: 2, viewportX: 0, viewportY: 0, scaled: { pageX: 0, pageY: 0, scale: 1.25 } },
      ],
    };
    const { scroll } = setup({ totalPages: 10, currentPage: 2, metrics });
    const { zoom } = setupZoom('fit-page', 1.25);

    expect(captureViewState(scroll, zoom, 'old', 2)).toMatchObject({
      page: 2,
      zoom: { level: 'fit-page', scale: 1.25 },
    });
  });

  test('150% 缩放下重载会先恢复缩放，再按页坐标恢复位置', async () => {
    const { manager, scroll, scrollToPage, forDocument } = setup({ totalPages: 10 });
    const { zoom, requestZoom, forDocument: zoomForDocument } = setupZoom(1.5, 1.5);

    await expect(
      apply(manager, scroll, {
        previous: {
          documentId: 'old',
          page: 5,
          offsetX: 150,
          offsetY: 300,
          zoom: { level: 1.5, scale: 1.5 },
        },
        targetPage: 5,
        zoom,
      }),
    ).resolves.toEqual({ documentId: 'new', page: 5 });

    expect(zoomForDocument).toHaveBeenCalledWith('new');
    expect(forDocument).toHaveBeenCalledWith('new');
    expect(requestZoom).toHaveBeenCalledWith(1.5);
    expect(requestZoom.mock.invocationCallOrder[0]).toBeLessThan(
      scrollToPage.mock.invocationCallOrder[0],
    );
    expect(scrollToPage).toHaveBeenCalledWith({
      pageNumber: 5,
      behavior: 'instant',
      pageCoordinates: { x: 100, y: 200 },
    });
  });

  test('metrics 的 scaled.scale 优先于 zoom.currentZoomLevel', async () => {
    const metrics: ScrollMetricsLike = {
      currentPage: 5,
      scrollOffset: { x: 0, y: 0 },
      pageVisibilityMetrics: [
        { pageNumber: 5, viewportX: 0, viewportY: 0, scaled: { pageX: 0, pageY: 400, scale: 2 } },
      ],
    };
    const { manager, scroll, scrollToPage } = setup({ totalPages: 10, currentPage: 5, metrics });
    const { zoom } = setupZoom(1.5, 1.5);
    const captured = captureViewState(scroll, zoom, 'old', 5);

    expect(captured).toMatchObject({
      page: 5,
      offsetY: 400,
      scale: 2,
      zoom: { level: 1.5, scale: 2 },
    });
    expect(captureViewState(scroll, undefined, 'old', 5)).toMatchObject({ scale: 2 });

    await apply(manager, scroll, {
      previous: { documentId: 'old', ...captured },
      targetPage: 5,
      zoom,
    });

    expect(scrollToPage).toHaveBeenCalledWith({
      pageNumber: 5,
      behavior: 'instant',
      pageCoordinates: { x: 0, y: 200 },
    });
  });

  test('零偏移仍明确传 pageCoordinates 0', async () => {
    const { manager, scroll, scrollToPage } = setup({ totalPages: 10 });
    const { zoom } = setupZoom(1.5, 1.5);

    await apply(manager, scroll, {
      previous: {
        documentId: 'old',
        page: 5,
        offsetX: 0,
        offsetY: 0,
        zoom: { level: 1.5, scale: 1.5 },
      },
      targetPage: 5,
      zoom,
    });

    expect(scrollToPage).toHaveBeenCalledWith({
      pageNumber: 5,
      behavior: 'instant',
      pageCoordinates: { x: 0, y: 0 },
    });
  });

  test('fit-page 按模式恢复，不写成固定比例', async () => {
    const { manager, scroll } = setup({ totalPages: 10 });
    const { zoom, requestZoom } = setupZoom('fit-page', 1.25);

    await apply(manager, scroll, {
      previous: {
        documentId: 'old',
        page: 2,
        offsetY: 0,
        zoom: { level: 'fit-page', scale: 1.25 },
      },
      targetPage: 2,
      zoom,
    });

    expect(requestZoom).toHaveBeenCalledWith('fit-page');
    expect(requestZoom).not.toHaveBeenCalledWith(1.25);
  });

  test('第 5 页页内偏移 300px 在 100% 下按 300 页坐标恢复', async () => {
    const { manager, scroll, scrollToPage } = setup({ totalPages: 10 });
    const { zoom } = setupZoom(1, 1);

    await expect(
      apply(manager, scroll, {
        previous: {
          documentId: 'old',
          page: 5,
          offsetY: 300,
          zoom: { level: 1, scale: 1 },
        },
        targetPage: 5,
        zoom,
      }),
    ).resolves.toEqual({ documentId: 'new', page: 5 });

    expect(scrollToPage).toHaveBeenCalledWith({
      pageNumber: 5,
      behavior: 'instant',
      pageCoordinates: { x: 0, y: 300 },
    });
  });

  test('停在两页之间时保留负偏移，不跳到页中央', async () => {
    const metrics: ScrollMetricsLike = {
      currentPage: 2,
      scrollOffset: { x: 0, y: 1000 },
      pageVisibilityMetrics: [
        { pageNumber: 2, viewportX: 0, viewportY: 80, scaled: { pageX: 0, pageY: 40, scale: 1 } },
      ],
    };
    const { manager, scroll, scrollToPage } = setup({
      totalPages: 10,
      currentPage: 2,
      metrics,
    });
    const { zoom } = setupZoom(1, 1);
    const captured = captureViewState(scroll, zoom, 'old', 2);

    expect(captured).toMatchObject({ page: 2, offsetY: -40, zoom: { level: 1, scale: 1 } });

    await expect(
      apply(manager, scroll, {
        previous: { documentId: 'old', ...captured },
        targetPage: 2,
        zoom,
      }),
    ).resolves.toEqual({ documentId: 'new', page: 2 });

    expect(scrollToPage).toHaveBeenCalledWith({
      pageNumber: 2,
      behavior: 'instant',
      pageCoordinates: { x: 0, y: -40 },
    });
    expect(scrollToPage.mock.calls[0][0].pageCoordinates?.y).not.toBe(0);
  });

  test('文档从 5 页变 3 页时夹到末页并应用偏移，不抛错', async () => {
    const { manager, scroll, scrollToPage } = setup({ totalPages: 3 });
    const { zoom } = setupZoom(1, 1);

    await expect(
      apply(manager, scroll, {
        previous: {
          documentId: 'old',
          page: 5,
          offsetY: 300,
          zoom: { level: 1, scale: 1 },
        },
        targetPage: 5,
        zoom,
      }),
    ).resolves.toEqual({ documentId: 'new', page: 3 });

    expect(scrollToPage).toHaveBeenCalledWith({
      pageNumber: 3,
      behavior: 'instant',
      pageCoordinates: { x: 0, y: 300 },
    });
  });

  test('打开失败时不再请求缩放或滚动，旧文档保持不动', async () => {
    const { manager, scroll, scrollToPage } = setup({
      openFailure: new Error('limit reached'),
    });
    const { zoom, requestZoom } = setupZoom(1.5, 1.5);

    await expect(
      apply(manager, scroll, {
        previous: {
          documentId: 'old',
          page: 5,
          offsetY: 300,
          zoom: { level: 1.5, scale: 1.5 },
        },
        targetPage: 5,
        zoom,
      }),
    ).rejects.toThrow('limit reached');

    expect(requestZoom).not.toHaveBeenCalled();
    expect(scrollToPage).not.toHaveBeenCalled();
  });
});

describe('跨重启的完整视图状态', () => {
  test('像素偏移换算成页坐标，缩放保留 mode 与实际比例', () => {
    const metrics: ScrollMetricsLike = {
      currentPage: 4,
      scrollOffset: { x: 0, y: 1000 },
      pageVisibilityMetrics: [
        { pageNumber: 4, viewportX: 20, viewportY: 30, scaled: { pageX: 170, pageY: 330, scale: 2 } },
      ],
    };
    const { scroll } = setup({ totalPages: 10, currentPage: 4, metrics });
    const { zoom } = setupZoom(1.5, 2);

    const persisted = toPersistedViewState(captureViewState(scroll, zoom, 'old', 4));

    expect(persisted).toEqual({
      v: 1,
      page: 4,
      x: 75,
      y: 150,
      zoom: { mode: 'numeric', level: 1.5 },
    });
  });

  test('fit 模式持久化为 mode，level 记录实际比例', () => {
    const metrics: ScrollMetricsLike = {
      currentPage: 2,
      scrollOffset: { x: 0, y: 0 },
      pageVisibilityMetrics: [
        { pageNumber: 2, viewportX: 0, viewportY: 40, scaled: { pageX: 0, pageY: 190, scale: 1.25 } },
      ],
    };
    const { scroll } = setup({ totalPages: 10, currentPage: 2, metrics });
    const { zoom } = setupZoom('fit-page', 1.25);

    expect(toPersistedViewState(captureViewState(scroll, zoom, 'old', 2))).toEqual({
      v: 1,
      page: 2,
      x: 0,
      y: 120,
      zoom: { mode: 'fit-page', level: 1.25 },
    });
  });

  test('首屏用持久化状态恢复：先按 mode 缩放，再按页坐标滚动', async () => {
    const { manager, scroll, scrollToPage, closeDocument, forDocument } = setup({ totalPages: 10 });
    const { zoom, requestZoom } = setupZoom('fit-page', 1.25);
    const restore = fromPersistedViewState({
      v: 1,
      page: 4,
      x: 100,
      y: -40,
      zoom: { mode: 'fit-page', level: 1.25 },
    });

    await expect(apply(manager, scroll, { restore, targetPage: 1, zoom })).resolves.toEqual({
      documentId: 'new',
      page: 4,
    });

    expect(forDocument).toHaveBeenCalledWith('new');
    expect(requestZoom).toHaveBeenCalledWith('fit-page');
    expect(requestZoom.mock.invocationCallOrder[0]).toBeLessThan(
      scrollToPage.mock.invocationCallOrder[0],
    );
    expect(scrollToPage).toHaveBeenCalledWith({
      pageNumber: 4,
      behavior: 'instant',
      pageCoordinates: { x: 100, y: -40 },
    });
    expect(closeDocument).not.toHaveBeenCalled();
  });

  test('numeric 缩放按 level 恢复，页码越界时夹到末页但保留坐标', async () => {
    const { manager, scroll, scrollToPage } = setup({ totalPages: 3 });
    const { zoom, requestZoom } = setupZoom(1.5, 1.5);
    const restore = fromPersistedViewState({
      v: 1,
      page: 9,
      x: 12,
      y: 34,
      zoom: { mode: 'numeric', level: 1.5 },
    });

    await expect(apply(manager, scroll, { restore, targetPage: 1, zoom })).resolves.toEqual({
      documentId: 'new',
      page: 3,
    });

    expect(requestZoom).toHaveBeenCalledWith(1.5);
    expect(scrollToPage).toHaveBeenCalledWith({
      pageNumber: 3,
      behavior: 'instant',
      pageCoordinates: { x: 12, y: 34 },
    });
  });

  test('旧 number 只有页码时恢复页码，不请求缩放', async () => {
    const { manager, scroll, scrollToPage } = setup({ totalPages: 10 });
    const { zoom, requestZoom } = setupZoom(1.5, 1.5);
    const restore = fromPersistedViewState({ v: 1, page: 2, x: 0, y: 0 });

    await apply(manager, scroll, { restore, targetPage: 1, zoom });

    expect(requestZoom).not.toHaveBeenCalled();
    expect(scrollToPage).toHaveBeenCalledWith({ pageNumber: 2, behavior: 'instant' });
  });

  test('没有 restore 时保持原行为：按 targetPage 跳转且不传坐标', async () => {
    const { manager, scroll, scrollToPage } = setup({ totalPages: 10 });

    await apply(manager, scroll, { targetPage: 6 });

    expect(scrollToPage).toHaveBeenCalledWith({ pageNumber: 6, behavior: 'instant' });
  });
});
