import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { PAGE_KEY_PREFIX, PageState, pageKey, type MementoLike } from '../src/extension/pageState';

const uri = 'file:///Volumes/%E5%A4%96%E7%BD%AE/a%20b.pdf';

function makeStore(getValue: unknown = undefined) {
  const get = vi.fn(() => getValue);
  const update = vi.fn(async () => {});
  return { get, update, memento: { get, update } as unknown as MementoLike };
}

function newState(store: ReturnType<typeof makeStore>, throttleMs?: number): PageState {
  return new PageState(store.memento, throttleMs);
}

describe('pageKey', () => {
  test('键按原 URI 拼接，中文与空格不丢', () => {
    expect(PAGE_KEY_PREFIX).toBe('embedpdf.page.');
    expect(pageKey(uri)).toBe('embedpdf.page.file:///Volumes/%E5%A4%96%E7%BD%AE/a%20b.pdf');
  });
});

describe('PageState.get', () => {
  test('空值用兜底', () => {
    const state = newState(makeStore(undefined));
    expect(state.get(uri, 4)).toBe(4);
  });

  test('存 0 也返回 1', () => {
    const state = newState(makeStore(0));
    expect(state.get(uri, 1)).toBe(1);
  });

  test('存 2.7 返回 2', () => {
    const state = newState(makeStore(2.7));
    expect(state.get(uri, 1)).toBe(2);
  });

  test('存非法字符串用兜底', () => {
    const state = newState(makeStore('abc'));
    expect(state.get(uri, 3)).toBe(3);
  });

  test('兜底值本身也夹到 >=1 的整数', () => {
    const state = newState(makeStore(undefined));
    expect(state.get(uri, 0)).toBe(1);
    expect(state.get(uri, 2.9)).toBe(2);
  });
});

describe('PageState.set', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test('节流，只写最后一页', () => {
    const store = makeStore();
    const state = newState(store, 500);
    state.set(uri, 3);
    state.set(uri, 4);
    state.set(uri, 5);
    expect(store.update).not.toHaveBeenCalled();
    vi.advanceTimersByTime(500);
    expect(store.update).toHaveBeenCalledTimes(1);
    expect(store.update).toHaveBeenCalledWith(pageKey(uri), 5);
  });

  test('非正数页码不写入', () => {
    const store = makeStore();
    const state = newState(store, 500);
    state.set(uri, 0);
    state.set(uri, -1);
    vi.advanceTimersByTime(500);
    expect(store.update).not.toHaveBeenCalled();
  });
});

describe('PageState.flush', () => {
  test('立即写，无待写则不调用', async () => {
    const store = makeStore();
    const state = newState(store);
    state.set(uri, 7);
    await state.flush();
    expect(store.update).toHaveBeenCalledWith(pageKey(uri), 7);
    store.update.mockClear();
    await state.flush();
    expect(store.update).not.toHaveBeenCalled();
  });
});

describe('PageState 写入失败', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test('失败页码放回待写，下一次 flush 重试', async () => {
    const store = makeStore();
    store.update.mockRejectedValueOnce(new Error('disk full'));
    const state = newState(store, 500);
    state.set(uri, 8);
    await vi.advanceTimersByTimeAsync(500);
    expect(store.update).toHaveBeenCalledTimes(1);

    await state.flush();
    expect(store.update).toHaveBeenCalledTimes(2);
    expect(store.update).toHaveBeenLastCalledWith(pageKey(uri), 8);
  });

  test('连续失败不抛未处理拒绝，且可反复重试', async () => {
    const store = makeStore();
    store.update.mockRejectedValue(new Error('disk full'));
    const state = newState(store);
    state.set(uri, 9);
    await expect(state.flush()).resolves.toBeUndefined();
    await expect(state.flush()).resolves.toBeUndefined();
    expect(store.update).toHaveBeenCalledTimes(2);
  });
});
