/**
 * 重载状态机：把文件事件（change/delete/create）、渲染失败与手动重载
 * 统一成“读取文件 → 发送字节”的节流/重试流程。
 *
 * revision 从 initialRevision（默认 0）开始，每次成功读取后递增，
 * 首次加载通常由 WebviewSession 记为 revision 1。
 */
export interface ReloadControllerOptions {
  readonly readFile: () => Promise<Uint8Array>;
  readonly onBytes: (bytes: Uint8Array, revision: number) => void;
  readonly onError: (kind: 'read' | 'render', message: string) => void;
  readonly debounceMs?: number;
  readonly deleteGraceMs?: number;
  readonly retryDelayMs?: number;
  readonly maxRetries?: number;
  readonly initialRevision?: number;
}

const DEFAULT_DEBOUNCE_MS = 300;
const DEFAULT_DELETE_GRACE_MS = 1500;
const DEFAULT_RETRY_DELAY_MS = 200;
const DEFAULT_MAX_RETRIES = 3;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class ReloadController {
  private readonly options: Required<
    Pick<
      ReloadControllerOptions,
      'debounceMs' | 'deleteGraceMs' | 'retryDelayMs' | 'maxRetries'
    >
  > &
    ReloadControllerOptions;

  private revision: number;
  private disposed = false;
  private debounceTimer: ReturnType<typeof setTimeout> | undefined;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private deleteTimer: ReturnType<typeof setTimeout> | undefined;
  private readFailures = 0;
  private renderFailures = 0;
  private loadToken = 0;

  constructor(options: ReloadControllerOptions) {
    this.options = {
      ...options,
      debounceMs: options.debounceMs ?? DEFAULT_DEBOUNCE_MS,
      deleteGraceMs: options.deleteGraceMs ?? DEFAULT_DELETE_GRACE_MS,
      retryDelayMs: options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS,
      maxRetries: options.maxRetries ?? DEFAULT_MAX_RETRIES,
    };
    this.revision = options.initialRevision ?? 0;
  }

  /** 文件内容变化：重置删除宽限与重试计数，去抖后读取。 */
  notifyChange(): void {
    if (this.disposed) return;
    this.clearTimers();
    this.renderFailures = 0;
    this.scheduleDebouncedRead();
  }

  /** 文件被删除：先等宽限期，期间没有重建事件才报 read 错误。 */
  notifyDelete(): void {
    if (this.disposed) return;
    this.clearTimers();
    this.deleteTimer = setTimeout(() => {
      this.deleteTimer = undefined;
      if (!this.disposed) {
        this.options.onError('read', '文件已删除');
      }
    }, this.options.deleteGraceMs);
  }

  /** 文件重新出现：取消删除宽限，按 change 处理。 */
  notifyCreate(): void {
    if (this.disposed) return;
    this.clearTimers();
    this.renderFailures = 0;
    this.scheduleDebouncedRead();
  }

  /**
   * webview 报告渲染失败：重新读取文件换一份字节，最多重试 maxRetries 次；
   * 连续失败耗尽后报 render 错误。
   */
  handleRenderFailure(): void {
    if (this.disposed) return;
    this.clearTimers();
    if (this.renderFailures >= this.options.maxRetries) {
      this.renderFailures = 0;
      this.options.onError('render', 'PDF 无法渲染');
      return;
    }
    this.renderFailures += 1;
    this.readFailures = 0;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      void this.readOnce('render');
    }, this.options.retryDelayMs);
  }

  /** 手动重载：跳过监听去抖，立即读取一次。 */
  async reloadNow(): Promise<void> {
    if (this.disposed) return;
    this.clearTimers();
    this.renderFailures = 0;
    this.readFailures = 0;
    await this.readOnce('read');
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clearTimers();
    this.loadToken += 1;
  }

  private scheduleDebouncedRead(): void {
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = undefined;
      this.readFailures = 0;
      void this.readOnce('read');
    }, this.options.debounceMs);
  }

  private async readOnce(kind: 'read' | 'render'): Promise<void> {
    const token = (this.loadToken += 1);
    let bytes: Uint8Array;
    try {
      bytes = await this.options.readFile();
    } catch (error) {
      if (this.disposed || token !== this.loadToken) return;
      if (this.readFailures < this.options.maxRetries) {
        this.readFailures += 1;
        this.retryTimer = setTimeout(() => {
          this.retryTimer = undefined;
          void this.readOnce(kind);
        }, this.options.retryDelayMs);
        return;
      }
      this.readFailures = 0;
      this.options.onError(kind, errorMessage(error));
      return;
    }
    if (this.disposed || token !== this.loadToken) return;
    this.readFailures = 0;
    this.revision += 1;
    this.options.onBytes(bytes, this.revision);
  }

  private clearTimers(): void {
    if (this.debounceTimer !== undefined) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = undefined;
    }
    if (this.retryTimer !== undefined) {
      clearTimeout(this.retryTimer);
      this.retryTimer = undefined;
    }
    if (this.deleteTimer !== undefined) {
      clearTimeout(this.deleteTimer);
      this.deleteTimer = undefined;
    }
  }
}
