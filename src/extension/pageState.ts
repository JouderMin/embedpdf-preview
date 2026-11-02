export const PAGE_KEY_PREFIX = 'embedpdf.page.';

export function pageKey(uri: string): string {
  return `${PAGE_KEY_PREFIX}${uri}`;
}

export interface MementoLike {
  get<T>(key: string, def: T): T;
  update(key: string, value: unknown): Promise<void>;
}

function normalizePage(value: unknown, fallback: number): number {
  const page = Math.trunc(Number(value));
  if (Number.isFinite(page) && page >= 1) {
    return page;
  }
  const fallbackPage = Math.trunc(Number(fallback));
  return Number.isFinite(fallbackPage) && fallbackPage >= 1 ? fallbackPage : 1;
}

/**
 * 按文档 URI 记录阅读页码。写入节流，窗口内只落最后一页，避免滚动时频繁写 Memento。
 */
export class PageState {
  private readonly pending = new Map<string, number>();
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly store: MementoLike,
    private readonly throttleMs = 500,
  ) {}

  get(uri: string, fallback: number): number {
    return normalizePage(this.store.get<unknown>(pageKey(uri), undefined), fallback);
  }

  set(uri: string, page: number): void {
    if (!Number.isFinite(page) || page < 1) {
      return;
    }
    this.pending.set(pageKey(uri), Math.trunc(page));
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

  private async writePending(): Promise<void> {
    const entries = [...this.pending.entries()];
    this.pending.clear();
    await Promise.all(entries.map(([key, page]) => this.store.update(key, page)));
  }
}
