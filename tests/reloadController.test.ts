import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { ReloadController, type ReloadControllerOptions } from '../src/extension/reloadController';

function setup(overrides: Partial<ReloadControllerOptions> = {}) {
  const readFile = vi.fn(async () => new Uint8Array([1, 2, 3]));
  const onBytes = vi.fn();
  const onError = vi.fn();
  const controller = new ReloadController({
    readFile,
    onBytes,
    onError,
    debounceMs: 300,
    deleteGraceMs: 1500,
    retryDelayMs: 200,
    maxRetries: 3,
    ...overrides,
  });
  return { controller, readFile, onBytes, onError };
}

async function advance(ms: number) {
  await vi.advanceTimersByTimeAsync(ms);
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('ReloadController 去抖', () => {
  test('300ms 内多次 change 只读一次', async () => {
    const { controller, readFile, onBytes } = setup();
    controller.notifyChange();
    controller.notifyChange();
    controller.notifyChange();
    expect(readFile).not.toHaveBeenCalled();
    await advance(299);
    expect(readFile).not.toHaveBeenCalled();
    await advance(1);
    expect(readFile).toHaveBeenCalledTimes(1);
    expect(onBytes).toHaveBeenCalledTimes(1);
  });

  test('revision 递增', async () => {
    const { controller, onBytes } = setup();
    controller.notifyChange();
    await advance(300);
    expect(onBytes.mock.calls[0][1]).toBe(1);
    controller.notifyChange();
    await advance(300);
    expect(onBytes.mock.calls[1][1]).toBe(2);
  });
});

describe('ReloadController 删除宽限', () => {
  test('删除后 1400ms 重建不出错，只重载一次', async () => {
    const { controller, readFile, onBytes, onError } = setup();
    controller.notifyDelete();
    await advance(1400);
    controller.notifyCreate();
    await advance(300);
    expect(onError).not.toHaveBeenCalled();
    expect(onBytes).toHaveBeenCalledTimes(1);
    expect(readFile).toHaveBeenCalledTimes(1);
  });

  test('删除 1500ms 后仍不存在，报 read', async () => {
    const { controller, readFile, onError } = setup();
    controller.notifyDelete();
    await advance(1500);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith('read', expect.any(String));
    expect(readFile).not.toHaveBeenCalled();
  });

  test('删除宽限期内 change 视为文件仍在，正常重载', async () => {
    const { controller, onBytes, onError } = setup();
    controller.notifyDelete();
    await advance(1000);
    controller.notifyChange();
    await advance(300);
    expect(onError).not.toHaveBeenCalled();
    expect(onBytes).toHaveBeenCalledTimes(1);
  });
});

describe('ReloadController 读取重试', () => {
  test('读取失败重试 3 次后报 read，成功则不报', async () => {
    const { controller, readFile, onBytes, onError } = setup();
    readFile.mockRejectedValueOnce(new Error('busy')).mockRejectedValueOnce(new Error('busy'));
    controller.notifyChange();
    await advance(300);
    await advance(200);
    await advance(200);
    expect(readFile).toHaveBeenCalledTimes(3);
    expect(onBytes).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
  });

  test('连续失败 3 次重试后报 read', async () => {
    const { controller, readFile, onError } = setup();
    readFile.mockRejectedValue(new Error('missing'));
    controller.notifyChange();
    await advance(300);
    await advance(200);
    await advance(200);
    await advance(200);
    expect(readFile).toHaveBeenCalledTimes(4);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith('read', expect.stringContaining('missing'));
  });
});

describe('ReloadController 渲染失败', () => {
  test('渲染失败触发重读，3 次后报 render', async () => {
    const { controller, readFile, onBytes, onError } = setup();
    for (let i = 0; i < 3; i += 1) {
      controller.handleRenderFailure();
      await advance(200);
    }
    expect(readFile).toHaveBeenCalledTimes(3);
    expect(onBytes).toHaveBeenCalledTimes(3);
    expect(onError).not.toHaveBeenCalled();

    controller.handleRenderFailure();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith('render', expect.any(String));
  });

  test('文件变化后渲染重试计数归零', async () => {
    const { controller, onError } = setup();
    for (let i = 0; i < 3; i += 1) {
      controller.handleRenderFailure();
      await advance(200);
    }
    controller.notifyChange();
    await advance(300);
    controller.handleRenderFailure();
    await advance(200);
    expect(onError).not.toHaveBeenCalled();
  });
});

describe('ReloadController 生命周期', () => {
  test('dispose 后不再读取', async () => {
    const { controller, readFile } = setup();
    controller.notifyChange();
    controller.dispose();
    await advance(5000);
    expect(readFile).not.toHaveBeenCalled();
  });

  test('reloadNow 立即读取，不等去抖', async () => {
    const { controller, readFile, onBytes } = setup();
    await controller.reloadNow();
    expect(readFile).toHaveBeenCalledTimes(1);
    expect(onBytes).toHaveBeenCalledWith(new Uint8Array([1, 2, 3]), 1);
  });
});
