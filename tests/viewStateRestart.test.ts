import { describe, expect, test, vi } from 'vitest';
import type { PersistedViewState } from '../src/shared/protocol';
import { PageState, pageKey, type MementoLike } from '../src/extension/pageState';
import type { ReloadController, ReloadControllerOptions } from '../src/extension/reloadController';
import { WebviewSession, type WebviewPort } from '../src/extension/webviewSession';
import {
  captureViewState,
  toPersistedViewState,
  type ScrollCapabilityLike,
  type ScrollMetricsLike,
} from '../src/webview/loadDocument';

const uri = 'file:///Volumes/%E5%A4%96%E7%BD%AE/a%20b.pdf';

/** 真实 Memento 语义：更新落副本，读取返回副本，模拟跨实例的 globalState。 */
class MapMemento implements MementoLike {
  readonly data = new Map<string, unknown>();

  get<T>(key: string, fallback: T): T {
    const value = this.data.get(key);
    return value === undefined ? fallback : (structuredClone(value) as T);
  }

  update(key: string, value: unknown): PromiseLike<void> {
    this.data.set(key, structuredClone(value));
    return Promise.resolve();
  }
}

function makePort() {
  const handlers = new Set<(message: unknown) => void>();
  const messages: Array<Record<string, unknown>> = [];
  const port: WebviewPort & { emit(message: unknown): void } = {
    postMessage: vi.fn(async (message: unknown) => {
      messages.push(message as Record<string, unknown>);
      return true;
    }),
    onMessage: (handler) => {
      handlers.add(handler);
      return { dispose: () => handlers.delete(handler) };
    },
    emit(message) {
      for (const handler of [...handlers]) {
        handler(message);
      }
    },
  };
  return { port, messages };
}

function makeController() {
  return {
    notifyChange: vi.fn(),
    notifyDelete: vi.fn(),
    notifyCreate: vi.fn(),
    handleRenderFailure: vi.fn(),
    reloadNow: vi.fn(async () => undefined),
    dispose: vi.fn(),
  } as unknown as ReloadController;
}

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function makeSession(pageState: PageState, port: WebviewPort, initialViewState: PersistedViewState) {
  return new WebviewSession({
    uri,
    name: 'a b.pdf',
    initialViewState,
    readFile: async () => new Uint8Array([1, 2, 3, 4]),
    pageState: {
      get: (key, fallback) => pageState.get(key, fallback),
      set: (key, state) => pageState.set(key, state),
      flush: () => pageState.flush(),
    },
    theme: () => 'dark',
    port,
    createController: (_options: ReloadControllerOptions) => makeController(),
  });
}

describe('跨实例（模拟 VS Code 重启）的完整状态', () => {
  test('set→flush→丢弃实例→新实例读回，磁盘保留页坐标与允许缩放的形状', async () => {
    const metrics: ScrollMetricsLike = {
      currentPage: 5,
      scrollOffset: { x: 0, y: 1000 },
      pageVisibilityMetrics: [
        { pageNumber: 5, viewportX: 0, viewportY: 0, scaled: { pageX: 0, pageY: 300, scale: 2 } },
      ],
    };
    const scroll = {
      forDocument: () => ({
        getCurrentPage: () => 5,
        getMetrics: () => metrics,
        scrollToPage: () => undefined,
      }),
      onLayoutReady: () => () => undefined,
    } as ScrollCapabilityLike;
    const zoom = {
      forDocument: () => ({
        getState: () => ({ zoomLevel: 1.5, currentZoomLevel: 2 }),
        requestZoom: () => undefined,
      }),
    };
    const captured = captureViewState(scroll, zoom, 'old', 5);
    const persisted = toPersistedViewState(captured);

    // 反向断言：写入的必须是页坐标和带 v 的对象，而不是像素或裸页码。
    expect(persisted).toMatchObject({
      v: 1,
      page: 5,
      x: 0,
      y: 150,
      zoom: { mode: 'numeric', level: 2 },
    });
    expect(persisted?.v).toBe(1);
    expect(persisted?.y).not.toBe(300);
    expect(persisted?.zoom?.level).not.toBe(1.5);

    const store = new MapMemento();
    const beforeRestart = new PageState(store, 500);
    beforeRestart.set(uri, persisted!);
    await beforeRestart.flush();

    const onDisk = store.get<unknown>(pageKey(uri), undefined);
    expect(onDisk).toEqual(persisted);

    // 丢弃旧实例，模拟扩展宿主重启后重新创建 PageState。
    const afterRestart = new PageState(store, 500);
    expect(afterRestart.get(uri, { v: 1, page: 1, x: 0, y: 0 })).toEqual(persisted);

    const { port, messages } = makePort();
    const session = makeSession(afterRestart, port, { v: 1, page: 1, x: 0, y: 0 });
    port.emit({ type: 'ready' });
    await flushMicrotasks();

    expect(messages.map((message) => message.type)).toEqual(['init', 'document']);
    expect(messages[0]).toMatchObject({
      type: 'init',
      page: 5,
      viewState: persisted,
    });
    expect(messages[1]).toMatchObject({
      type: 'document',
      page: 5,
      viewState: persisted,
    });
    session.dispose();
  });

  test('旧 number 值在新实例里只回页码，init/document 不携带缩放或偏移', async () => {
    const store = new MapMemento();
    store.data.set(pageKey(uri), 4);

    const pageState = new PageState(store, 500);
    expect(pageState.get(uri, { v: 1, page: 1, x: 0, y: 0 })).toEqual({
      v: 1,
      page: 4,
      x: 0,
      y: 0,
    });

    const { port, messages } = makePort();
    const session = makeSession(pageState, port, { v: 1, page: 1, x: 0, y: 0 });
    port.emit({ type: 'ready' });
    await flushMicrotasks();

    expect(messages[0]).toMatchObject({
      type: 'init',
      page: 4,
      viewState: { v: 1, page: 4, x: 0, y: 0 },
    });
    expect(messages[1]).toMatchObject({
      type: 'document',
      page: 4,
      viewState: { v: 1, page: 4, x: 0, y: 0 },
    });
    session.dispose();
  });
});
