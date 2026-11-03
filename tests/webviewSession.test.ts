import { describe, expect, test, vi } from 'vitest';
import type { PersistedViewState } from '../src/shared/protocol';
import type { ReloadController, ReloadControllerOptions } from '../src/extension/reloadController';
import {
  WebviewSession,
  type WebviewPort,
  type WebviewSessionOptions,
} from '../src/extension/webviewSession';

const uri = 'file:///Volumes/%E5%A4%96%E7%BD%AE/a%20b.pdf';

type Handler = (message: unknown) => void;

function makePort() {
  const handlers = new Set<Handler>();
  const messages: Array<Record<string, unknown>> = [];
  const port: WebviewPort & { messages: typeof messages; emit(message: unknown): void } = {
    messages,
    postMessage: vi.fn(async (message: unknown) => {
      messages.push(message as Record<string, unknown>);
      return true;
    }),
    onMessage: vi.fn((handler: Handler) => {
      handlers.add(handler);
      return { dispose: () => handlers.delete(handler) };
    }),
    emit(message: unknown) {
      for (const handler of [...handlers]) {
        handler(message);
      }
    },
  };
  return { port, messages, handlers };
}

function makePageState(initial = 5) {
  const state: PersistedViewState = { v: 1, page: initial, x: 0, y: 0 };
  const get = vi.fn(() => state);
  const set = vi.fn();
  const flush = vi.fn(async () => {});
  return { get, set, flush, state };
}

function makeFactory() {
  const controllers: Array<{
    options: ReloadControllerOptions;
    notifyChange: ReturnType<typeof vi.fn>;
    notifyDelete: ReturnType<typeof vi.fn>;
    notifyCreate: ReturnType<typeof vi.fn>;
    handleRenderFailure: ReturnType<typeof vi.fn>;
    reloadNow: ReturnType<typeof vi.fn>;
    dispose: ReturnType<typeof vi.fn>;
  }> = [];
  const createController = vi.fn((options: ReloadControllerOptions) => {
    const controller = {
      options,
      notifyChange: vi.fn(),
      notifyDelete: vi.fn(),
      notifyCreate: vi.fn(),
      handleRenderFailure: vi.fn(),
      reloadNow: vi.fn(async () => {
        const bytes = await options.readFile();
        options.onBytes(bytes, 2);
      }),
      dispose: vi.fn(),
    };
    controllers.push(controller);
    return controller as unknown as ReloadController;
  });
  return { createController, controllers };
}

function createSession(overrides: Partial<WebviewSessionOptions> = {}) {
  const { port, messages, handlers } = makePort();
  const pageState = makePageState();
  const { createController, controllers } = makeFactory();
  const readFile = vi.fn(async () => new Uint8Array([1, 2, 3, 4]));
  const session = new WebviewSession({
    uri,
    name: 'a b.pdf',
    initialViewState: { v: 1, page: 1, x: 0, y: 0 },
    readFile,
    pageState,
    theme: () => 'dark',
    port,
    createController,
    ...overrides,
  });
  return { session, port, messages, handlers, pageState, createController, controllers, readFile };
}

async function flush() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe('WebviewSession 首次加载', () => {
  test('未 ready 前不发消息，也不建状态机', async () => {
    const { messages, createController } = createSession();
    await flush();
    expect(messages).toEqual([]);
    expect(createController).not.toHaveBeenCalled();
  });

  test('ready 后依次收到 init 与 document，并开始监听', async () => {
    const { port, messages, pageState, createController } = createSession();
    port.emit({ type: 'ready' });
    await flush();

    expect(messages.map((message) => message.type)).toEqual(['init', 'document']);
    expect(messages[0]).toEqual({
      type: 'init',
      uri,
      name: 'a b.pdf',
      page: 5,
      viewState: { v: 1, page: 5, x: 0, y: 0 },
      theme: 'dark',
    });
    const document = messages[1] as {
      bytes: ArrayBuffer;
      page: number;
      viewState: { v: 1; page: number; x: number; y: number };
      revision: number;
    };
    expect(document.bytes.byteLength).toBe(4);
    expect(document.page).toBe(5);
    expect(document.viewState).toEqual({ v: 1, page: 5, x: 0, y: 0 });
    expect(document.revision).toBe(1);
    expect(pageState.get).toHaveBeenCalled();
    expect(createController).toHaveBeenCalledTimes(1);
    expect(port.onMessage).toHaveBeenCalledTimes(1);
  });

  test('init 与 document 带完整持久化状态', async () => {
    const { port, pageState, messages } = createSession();
    pageState.get.mockReturnValue({
      v: 1,
      page: 7,
      x: 12,
      y: -4,
      zoom: { mode: 'fit-page', level: 1.25 },
    });
    port.emit({ type: 'ready' });
    await flush();

    expect(messages[0]).toMatchObject({
      type: 'init',
      page: 7,
      viewState: {
        v: 1,
        page: 7,
        x: 12,
        y: -4,
        zoom: { mode: 'fit-page', level: 1.25 },
      },
    });
    expect(messages[1]).toMatchObject({
      type: 'document',
      page: 7,
      viewState: {
        v: 1,
        page: 7,
        x: 12,
        y: -4,
        zoom: { mode: 'fit-page', level: 1.25 },
      },
    });
  });

  test('重复 ready 只初始化一次', async () => {
    const { port, messages } = createSession();
    port.emit({ type: 'ready' });
    await flush();
    port.emit({ type: 'ready' });
    await flush();
    expect(messages.map((message) => message.type)).toEqual(['init', 'document']);
  });

  test('首次读取失败发 read 错误，仍建立状态机供重试', async () => {
    const readFile = vi.fn(async () => {
      throw new Error('EACCES');
    });
    const { port, messages, createController, controllers } = createSession({ readFile });
    port.emit({ type: 'ready' });
    await flush();
    expect(messages.map((message) => message.type)).toEqual(['init', 'error']);
    expect(messages[1]).toMatchObject({ type: 'error', kind: 'read' });
    expect((messages[1] as { message: string }).message).toContain('EACCES');
    expect(createController).toHaveBeenCalledTimes(1);
    expect(controllers[0].options.initialRevision).toBe(0);
  });
});

describe('WebviewSession 消息处理', () => {
  test('viewState 写入完整状态，非法消息忽略', async () => {
    const { port, pageState } = createSession();
    port.emit({ type: 'ready' });
    await flush();

    port.emit({
      type: 'viewState',
      page: 6,
      x: 12,
      y: -4,
      zoom: { mode: 'fit-page', level: 1.25 },
    });
    expect(pageState.set).toHaveBeenCalledWith(uri, {
      v: 1,
      page: 6,
      x: 12,
      y: -4,
      zoom: { mode: 'fit-page', level: 1.25 },
    });
    expect(() => port.emit({ type: 'x' })).not.toThrow();
    expect(() => port.emit({ type: 'viewState', page: '6', x: 0, y: 0 })).not.toThrow();
    expect(() =>
      port.emit({ type: 'viewState', page: 6, x: 0, y: 0, zoom: { mode: 'fit-height', level: 1 } }),
    ).not.toThrow();
    expect(pageState.set).toHaveBeenCalledTimes(1);
  });

  test('旧 page 消息只更新页码并保留已存坐标与缩放', async () => {
    const { port, pageState } = createSession();
    pageState.get.mockReturnValue({
      v: 1,
      page: 5,
      x: 10,
      y: 20,
      zoom: { mode: 'numeric', level: 1.5 },
    });
    port.emit({ type: 'ready' });
    await flush();

    port.emit({ type: 'page', page: 4 });
    expect(pageState.set).toHaveBeenCalledWith(uri, {
      v: 1,
      page: 4,
      x: 10,
      y: 20,
      zoom: { mode: 'numeric', level: 1.5 },
    });
  });

  test('渲染失败交给状态机重读', async () => {
    const { port, controllers } = createSession();
    port.emit({ type: 'ready' });
    await flush();
    port.emit({ type: 'error', kind: 'render', message: 'm' });
    expect(controllers[0].handleRenderFailure).toHaveBeenCalledTimes(1);
  });

  test('retry 触发 reloadNow', async () => {
    const { port, controllers } = createSession();
    port.emit({ type: 'ready' });
    await flush();
    port.emit({ type: 'retry' });
    expect(controllers[0].reloadNow).toHaveBeenCalledTimes(1);
  });
});

describe('WebviewSession 主题与文件事件', () => {
  test('setTheme 只发 theme 消息', async () => {
    const { session, port, messages } = createSession();
    port.emit({ type: 'ready' });
    await flush();
    messages.length = 0;
    port.emit({ type: 'viewState', page: 3, x: 0, y: 0 });
    session.setTheme('light');
    expect(messages).toHaveLength(1);
    expect(messages[0]).toEqual({ type: 'theme', theme: 'light' });
  });

  test('watcher 事件转发到 controller', async () => {
    const { session, port, controllers } = createSession();
    port.emit({ type: 'ready' });
    await flush();
    const controller = controllers[0];
    session.notifyChange();
    session.notifyDelete();
    session.notifyCreate();
    expect(controller.notifyChange).toHaveBeenCalledTimes(1);
    expect(controller.notifyDelete).toHaveBeenCalledTimes(1);
    expect(controller.notifyCreate).toHaveBeenCalledTimes(1);
  });
});

describe('WebviewSession dispose', () => {
  test('dispose 释放消息订阅、controller，并 flush 待写状态', async () => {
    const { session, port, controllers, pageState } = createSession();
    port.emit({ type: 'ready' });
    await flush();
    session.dispose();
    expect(controllers[0].dispose).toHaveBeenCalledTimes(1);
    expect(port.onMessage).toHaveBeenCalledTimes(1);
    expect(pageState.flush).toHaveBeenCalledTimes(1);
    port.emit({ type: 'viewState', page: 9, x: 0, y: 0, zoom: { mode: 'numeric', level: 1 } });
    expect(pageState.set).not.toHaveBeenCalled();
  });
});

describe('WebviewSession 手动重载', () => {
  test('未 ready 时 reloadNow 不报错，ready 后委托给 controller', async () => {
    const { session, port, controllers } = createSession();
    await expect(session.reloadNow()).resolves.toBeUndefined();
    expect(controllers).toHaveLength(0);

    port.emit({ type: 'ready' });
    await flush();
    await session.reloadNow();
    expect(controllers[0].reloadNow).toHaveBeenCalledTimes(1);
  });
});
