import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { PersistedViewState } from '../src/shared/protocol';
import { PAGE_KEY_PREFIX, PageState, pageKey, type MementoLike } from '../src/extension/pageState';

const uri = 'file:///Volumes/%E5%A4%96%E7%BD%AE/a%20b.pdf';

function view(overrides: Partial<PersistedViewState> = {}): PersistedViewState {
  return { v: 1, page: 1, x: 0, y: 0, ...overrides };
}

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
  test('空值用兜底页码，坐标与缩放从零开始', () => {
    const state = newState(makeStore(undefined));
    expect(state.get(uri, view({ page: 4 }))).toEqual(view({ page: 4 }));
  });

  test('旧 number 值按页码兼容', () => {
    const state = newState(makeStore(2.7));
    expect(state.get(uri, view({ page: 1 }))).toEqual(view({ page: 2 }));
  });

  test('旧 number 存 0 也回退到兜底页码', () => {
    const state = newState(makeStore(0));
    expect(state.get(uri, view({ page: 4 }))).toEqual(view({ page: 4 }));
  });

  test('完整对象原样读出，包含负数页坐标与 fit 缩放', () => {
    const stored = view({
      page: 7,
      x: -12,
      y: 340,
      zoom: { mode: 'fit-width', level: 1.4 },
    });
    const state = newState(makeStore(stored));
    expect(state.get(uri, view({ page: 1 }))).toEqual(stored);
  });

  test('非法或未知版本对象回退到兜底页码', () => {
    const state = newState(
      makeStore({ v: 2, page: 9, x: 10, y: 20, zoom: { mode: 'numeric', level: 2 } }),
    );
    expect(state.get(uri, view({ page: 3 }))).toEqual(view({ page: 3 }));
  });

  test('对象里缺失/非法坐标或缩放时回退，不返回半截状态', () => {
    const state = newState(makeStore({ v: 1, page: 9, x: '0', y: 20 }));
    expect(state.get(uri, view({ page: 3 }))).toEqual(view({ page: 3 }));

    const badZoom = newState(
      makeStore({ v: 1, page: 9, x: 0, y: 0, zoom: { mode: 'fit-height', level: 1 } }),
    );
    expect(badZoom.get(uri, view({ page: 3 }))).toEqual(view({ page: 3 }));
  });

  test('兜底页码本身也夹到 >=1 的整数', () => {
    const state = newState(makeStore(undefined));
    expect(state.get(uri, view({ page: 0 }))).toEqual(view({ page: 1 }));
    expect(state.get(uri, view({ page: 2.9 }))).toEqual(view({ page: 2 }));
  });
});

describe('PageState.set', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test('节流窗口内合并，只写最后一个完整状态', () => {
    const store = makeStore();
    const state = newState(store, 500);
    state.set(uri, view({ page: 3, y: 10, zoom: { mode: 'numeric', level: 1 } }));
    state.set(uri, view({ page: 4, y: 20, zoom: { mode: 'numeric', level: 1.25 } }));
    state.set(uri, view({ page: 5, y: -30, zoom: { mode: 'fit-page', level: 1.5 } }));
    expect(store.update).not.toHaveBeenCalled();
    vi.advanceTimersByTime(500);
    expect(store.update).toHaveBeenCalledTimes(1);
    expect(store.update).toHaveBeenCalledWith(
      pageKey(uri),
      view({ page: 5, y: -30, zoom: { mode: 'fit-page', level: 1.5 } }),
    );
  });

  test('写入前 get 能读到待写状态', () => {
    const store = makeStore();
    const state = newState(store, 500);
    state.set(uri, view({ page: 6, x: 12, y: 34 }));
    expect(state.get(uri, view({ page: 1 }))).toEqual(view({ page: 6, x: 12, y: 34 }));
  });

  test('非正数页码或非法坐标不写入', () => {
    const store = makeStore();
    const state = newState(store, 500);
    state.set(uri, view({ page: 0 }));
    state.set(uri, view({ page: -1 }));
    state.set(uri, view({ page: 2, x: Number.NaN }));
    vi.advanceTimersByTime(500);
    expect(store.update).not.toHaveBeenCalled();
  });
});

describe('PageState.flush', () => {
  test('立即写完整对象，无待写则不调用', async () => {
    const store = makeStore();
    const state = newState(store);
    state.set(uri, view({ page: 7, x: 8, y: 9, zoom: { mode: 'numeric', level: 2 } }));
    await state.flush();
    expect(store.update).toHaveBeenCalledWith(
      pageKey(uri),
      view({ page: 7, x: 8, y: 9, zoom: { mode: 'numeric', level: 2 } }),
    );
    store.update.mockClear();
    await state.flush();
    expect(store.update).not.toHaveBeenCalled();
  });
});

describe('PageState.dispose', () => {
  test('dispose 时 flush 待写状态', async () => {
    const store = makeStore();
    const state = newState(store);
    state.set(uri, view({ page: 11, y: 22 }));
    await state.dispose();
    expect(store.update).toHaveBeenCalledWith(pageKey(uri), view({ page: 11, y: 22 }));
  });
});

describe('PageState 写入失败', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test('失败状态放回待写，下一次 flush 重试', async () => {
    const store = makeStore();
    store.update.mockRejectedValueOnce(new Error('disk full'));
    const state = newState(store, 500);
    const stateValue = view({ page: 8, x: 1, y: 2 });
    state.set(uri, stateValue);
    await vi.advanceTimersByTimeAsync(500);
    expect(store.update).toHaveBeenCalledTimes(1);

    await state.flush();
    expect(store.update).toHaveBeenCalledTimes(2);
    expect(store.update).toHaveBeenLastCalledWith(pageKey(uri), stateValue);
  });

  test('连续失败不抛未处理拒绝，且可反复重试', async () => {
    const store = makeStore();
    store.update.mockRejectedValue(new Error('disk full'));
    const state = newState(store);
    state.set(uri, view({ page: 9 }));
    await expect(state.flush()).resolves.toBeUndefined();
    await expect(state.flush()).resolves.toBeUndefined();
    expect(store.update).toHaveBeenCalledTimes(2);
  });
});
