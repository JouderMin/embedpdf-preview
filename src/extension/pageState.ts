import {
  isPersistedViewState,
  isPersistedZoom,
  type PersistedViewState,
  type PersistedZoom,
} from '../shared/protocol';

export const PAGE_KEY_PREFIX = 'embedpdf.page.';

export function pageKey(uri: string): string {
  return `${PAGE_KEY_PREFIX}${uri}`;
}

export interface MementoLike {
  get<T>(key: string, def: T): T;
  update(key: string, value: unknown): PromiseLike<void>;
}

function normalizePage(value: unknown, fallback: number): number {
  const page = Math.trunc(Number(value));
  if (Number.isFinite(page) && page >= 1) {
    return page;
  }
  const fallbackPage = Math.trunc(Number(fallback));
  return Number.isFinite(fallbackPage) && fallbackPage >= 1 ? fallbackPage : 1;
}

function cloneZoom(zoom: PersistedZoom | undefined): PersistedZoom | undefined {
  return zoom ? { mode: zoom.mode, level: zoom.level } : undefined;
}

function cloneViewState(state: PersistedViewState): PersistedViewState {
  return {
    v: 1,
    page: state.page,
    x: state.x,
    y: state.y,
    ...(state.zoom ? { zoom: cloneZoom(state.zoom) } : {}),
  };
}

function fallbackViewState(fallback: PersistedViewState): PersistedViewState {
  return {
    v: 1,
    page: normalizePage(fallback.page, 1),
    x: Number.isFinite(fallback.x) ? fallback.x : 0,
    y: Number.isFinite(fallback.y) ? fallback.y : 0,
    ...(fallback.zoom ? { zoom: cloneZoom(fallback.zoom) } : {}),
  };
}

/**
 * 兼容旧值：历史版本只存页码 number；新值存 PersistedViewState。
 * 非法形状整体回退，不返回半截状态。
 */
export function normalizeViewState(
  value: unknown,
  fallback: PersistedViewState,
): PersistedViewState {
  if (typeof value === 'number') {
    return {
      v: 1,
      page: normalizePage(value, fallback.page),
      x: 0,
      y: 0,
    };
  }
  if (isPersistedViewState(value)) {
    return cloneViewState(value);
  }
  return fallbackViewState(fallback);
}

/**
 * 按文档 URI 记录完整阅读状态（页码、页坐标、缩放）。写入节流，
 * 窗口内只落最后一个状态，避免滚动时频繁写 Memento。
 */
export class PageState {
  private readonly pending = new Map<string, PersistedViewState>();
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly store: MementoLike,
    private readonly throttleMs = 500,
  ) {}

  get(uri: string, fallback: PersistedViewState): PersistedViewState {
    const key = pageKey(uri);
    const pending = this.pending.get(key);
    if (pending) {
      return cloneViewState(pending);
    }
    return normalizeViewState(this.store.get<unknown>(key, undefined), fallback);
  }

  set(uri: string, state: PersistedViewState): void {
    const page = Math.trunc(state.page);
    if (!Number.isFinite(page) || page < 1) {
      return;
    }
    if (!Number.isFinite(state.x) || !Number.isFinite(state.y)) {
      return;
    }
    if (state.zoom && !isPersistedZoom(state.zoom)) {
      return;
    }
    this.pending.set(pageKey(uri), {
      v: 1,
      page,
      x: state.x,
      y: state.y,
      ...(state.zoom ? { zoom: cloneZoom(state.zoom) } : {}),
    });
    if (this.timer === undefined) {
      this.timer = setTimeout(() => {
        this.timer = undefined;
        void this.writePending();
      }, this.throttleMs);
    }
  }

  async flush(): Promise<void> {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    await this.writePending();
  }

  /** 编辑器关闭时把待写状态落盘。 */
  async dispose(): Promise<void> {
    await this.flush();
  }

  private async writePending(): Promise<void> {
    const entries = [...this.pending.entries()];
    this.pending.clear();
    await Promise.all(
      entries.map(async ([key, state]) => {
        try {
          await this.store.update(key, state);
        } catch {
          // 写入失败时放回待写队列，下一次节流或 flush 再试；
          // 若期间已经产生了更新的状态，则保留新值，避免旧状态覆盖。
          if (!this.pending.has(key)) {
            this.pending.set(key, state);
          }
        }
      }),
    );
  }
}
