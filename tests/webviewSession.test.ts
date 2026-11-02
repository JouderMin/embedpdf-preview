import { describe, expect, test, vi } from 'vitest';
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
  return {
    get: vi.fn(() => initial),
    set: vi.fn(),
  };
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
    initialPage: 1,
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
      theme: 'dark',
    });
    const document = messages[1] as { bytes: ArrayBuffer; page: number; revision: number };
    expect(document.bytes.byteLength).toBe(4);
    expect(document.page).toBe(5);
    expect(document.revision).toBe(1);
    expect(pageState.get).toHaveBeenCalled();
    expect(createController).toHaveBeenCalledTimes(1);
    expect(port.onMessage).toHaveBeenCalledTimes(1);
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
  test('page 消息写入页码，非法消息忽略', async () => {
    const { port, pageState } = createSession();
    port.emit({ type: 'ready' });
    await flush();

    port.emit({ type: 'page', page: 4 });
    expect(pageState.set).toHaveBeenCalledWith(uri, 4);
    expect(() => port.emit({ type: 'x' })).not.toThrow();
    expect(() => port.emit({ type: 'page', page: '4' })).not.toThrow();
    expect(pageState.set).toHaveBeenCalledTimes(1);
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
    port.emit({ type: 'page', page: 3 });
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
  test('dispose 释放消息订阅与 controller', async () => {
    const { session, port, controllers, pageState } = createSession();
    port.emit({ type: 'ready' });
    await flush();
    session.dispose();
    expect(controllers[0].dispose).toHaveBeenCalledTimes(1);
    expect(port.onMessage).toHaveBeenCalledTimes(1);
    port.emit({ type: 'page', page: 9 });
    expect(pageState.set).not.toHaveBeenCalled();
  });
});
