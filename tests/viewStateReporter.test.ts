import { afterEach, describe, expect, test, vi } from 'vitest';
import type { PersistedZoom } from '../src/shared/protocol';
import {
  bindViewStateLifecycle,
  ViewStateReporter,
  type DocumentLike,
  type EventTargetLike,
  type ViewStateSnapshot,
} from '../src/webview/viewStateReporter';

class FakeTarget implements EventTargetLike {
  private readonly listeners = new Map<string, Set<() => void>>();

  addEventListener(type: string, listener: () => void): void {
    const set = this.listeners.get(type) ?? new Set();
    set.add(listener);
    this.listeners.set(type, set);
  }

  removeEventListener(type: string, listener: () => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  dispatch(type: string): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) {
      listener();
    }
  }
}

class FakeDocument extends FakeTarget implements DocumentLike {
  visibilityState = 'visible';
}

function snapshot(page = 5, y = 150, zoom: PersistedZoom = { mode: 'numeric', level: 2 }): ViewStateSnapshot {
  return { page, x: 0, y, zoom };
}

function makeReporter(capture: () => ViewStateSnapshot | undefined) {
  const posts: unknown[] = [];
  const reporter = new ViewStateReporter({
    capture,
    post: (message) => posts.push(message),
    debounceMs: 300,
  });
  return { reporter, posts };
}

describe('ViewStateReporter 销毁前补发', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  test('pagehide 在去抖未到期时立即发送当前值，并且只发一次', () => {
    vi.useFakeTimers();
    let current = snapshot();
    const { reporter, posts } = makeReporter(() => current);
    const win = new FakeTarget();
    const doc = new FakeDocument();
    const unbind = bindViewStateLifecycle(reporter, win, doc);

    reporter.schedule();
    expect(posts).toHaveLength(0);

    // 滚动后状态已更新，但 300ms 去抖还没到；pagehide 应同步取最新值。
    current = snapshot(9, -40, { mode: 'fit-page', level: 1.25 });
    win.dispatch('pagehide');

    expect(posts).toEqual([
      { type: 'viewState', page: 9, x: 0, y: -40, zoom: { mode: 'fit-page', level: 1.25 } },
    ]);

    // 紧接的 visibilitychange 不应重复发送，定时器也不应再触发一次。
    doc.visibilityState = 'hidden';
    doc.dispatch('visibilitychange');
    vi.advanceTimersByTime(300);
    expect(posts).toHaveLength(1);
    unbind();
  });

  test('visibilitychange 只有 hidden 时补发，visible 不发送', () => {
    vi.useFakeTimers();
    const { reporter, posts } = makeReporter(() => snapshot(3, 6));
    const win = new FakeTarget();
    const doc = new FakeDocument();
    const unbind = bindViewStateLifecycle(reporter, win, doc);

    reporter.schedule();
    doc.visibilityState = 'visible';
    doc.dispatch('visibilitychange');
    expect(posts).toHaveLength(0);

    doc.visibilityState = 'hidden';
    doc.dispatch('visibilitychange');
    expect(posts).toEqual([
      { type: 'viewState', page: 3, x: 0, y: 6, zoom: { mode: 'numeric', level: 2 } },
    ]);
    vi.advanceTimersByTime(300);
    expect(posts).toHaveLength(1);
    unbind();
  });

  test('capture 抛错时不上报也不抛出', () => {
    vi.useFakeTimers();
    const posts: unknown[] = [];
    const reporter = new ViewStateReporter({
      capture: () => {
        throw new Error('metrics not ready');
      },
      post: (message) => posts.push(message),
      debounceMs: 300,
    });
    const win = new FakeTarget();
    const doc = new FakeDocument();
    const unbind = bindViewStateLifecycle(reporter, win, doc);

    reporter.schedule();
    expect(() => win.dispatch('pagehide')).not.toThrow();
    expect(posts).toHaveLength(0);
    unbind();
  });

  test('没有待发状态时 flushPending 返回 false，不重复发送', () => {
    const { reporter, posts } = makeReporter(() => snapshot());
    expect(reporter.flushPending()).toBe(false);
    expect(posts).toHaveLength(0);
    reporter.schedule();
    expect(reporter.flushPending()).toBe(true);
    expect(reporter.flushPending()).toBe(false);
    expect(posts).toHaveLength(1);
  });
});
