import type { PersistedZoom, WebviewToHost } from '../shared/protocol';

export interface ViewStateSnapshot {
  page: number;
  x: number;
  y: number;
  zoom: PersistedZoom;
}

export interface ViewStateReporterOptions {
  /** 同步读取当前状态；拿不到（例如 metrics 未就绪）时返回 undefined。 */
  capture: () => ViewStateSnapshot | undefined;
  post: (message: WebviewToHost) => void;
  /** 常规滚动/缩放/页码变化的尾部去抖。 */
  debounceMs?: number;
}

/** 页面关闭/隐藏时可绑定的最小事件源，便于在 Node 测试里替换。 */
export interface EventTargetLike {
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
}

export interface DocumentLike extends EventTargetLike {
  readonly visibilityState: string;
}

/**
 * 视图状态上报器：常规事件走尾部去抖；页面即将销毁时可用 flushPending()
 * 同步补发尚未到期的最后状态，避免关闭/重启前最后一段滚动丢失。
 */
export class ViewStateReporter {
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly options: ViewStateReporterOptions) {}

  /** 重新计时；窗口内只保留最后一次。 */
  schedule(): void {
    this.clearTimer();
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.emit();
    }, this.options.debounceMs ?? 300);
  }

  /**
   * 立即补发尚未到期的状态。没有待发定时器时返回 false，避免 pagehide 与
   * visibilitychange 连续触发时重复发送同一条状态。
   */
  flushPending(): boolean {
    if (this.timer === undefined) {
      return false;
    }
    this.clearTimer();
    this.emit();
    return true;
  }

  dispose(): void {
    this.clearTimer();
  }

  private emit(): void {
    try {
      const snapshot = this.options.capture();
      if (!snapshot) {
        return;
      }
      this.options.post({
        type: 'viewState',
        page: snapshot.page,
        x: snapshot.x,
        y: snapshot.y,
        zoom: snapshot.zoom,
      });
    } catch {
      // 销毁前上报是 best-effort；读取或发送失败不影响关闭流程。
    }
  }

  private clearTimer(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }
}

/** 在页面隐藏/销毁前绕过去抖补发；返回解绑函数。 */
export function bindViewStateLifecycle(
  reporter: ViewStateReporter,
  windowTarget: EventTargetLike,
  documentTarget: DocumentLike,
): () => void {
  const onPageHide = () => {
    reporter.flushPending();
  };
  const onVisibilityChange = () => {
    if (documentTarget.visibilityState === 'hidden') {
      reporter.flushPending();
    }
  };
  windowTarget.addEventListener('pagehide', onPageHide);
  documentTarget.addEventListener('visibilitychange', onVisibilityChange);
  return () => {
    windowTarget.removeEventListener('pagehide', onPageHide);
    documentTarget.removeEventListener('visibilitychange', onVisibilityChange);
  };
}
