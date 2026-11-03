import type {
  HostToWebview,
  PersistedViewState,
  Theme,
  WebviewToHost,
} from '../shared/protocol';
import { isWebviewToHost } from '../shared/protocol';
import type { ReloadController, ReloadControllerOptions } from './reloadController';

/** VS Code webview 的最小消息端口，便于在测试中替换。 */
export interface WebviewPort {
  postMessage(message: unknown): PromiseLike<boolean>;
  onMessage(handler: (message: unknown) => void): { dispose(): void };
}

export interface WebviewSessionOptions {
  readonly uri: string;
  readonly name: string;
  readonly initialViewState: PersistedViewState;
  readonly readFile: () => Promise<Uint8Array>;
  readonly pageState: {
    get(key: string, fallback: PersistedViewState): PersistedViewState;
    set(key: string, state: PersistedViewState): void;
    flush?(): PromiseLike<void> | void;
  };
  readonly theme: () => Theme;
  readonly port: WebviewPort;
  readonly createController: (options: ReloadControllerOptions) => ReloadController;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 复制出独立的 ArrayBuffer，避免把整个底层池一起 structured clone 过去。 */
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

/**
 * 单个 PDF 编辑器与 webview 之间的会话：负责首次加载、页码回写、
 * 主题同步，并把 watcher / webview 的事件交给重载状态机。
 */
export class WebviewSession {
  private readonly subscription: { dispose(): void };
  private readonly options: WebviewSessionOptions;
  private controller: ReloadController | undefined;
  private currentTheme: Theme;
  private ready = false;
  private disposed = false;

  constructor(options: WebviewSessionOptions) {
    this.options = options;
    this.currentTheme = options.theme();
    this.subscription = options.port.onMessage((message) => this.handleMessage(message));
  }

  notifyChange(): void {
    this.controller?.notifyChange();
  }

  notifyDelete(): void {
    this.controller?.notifyDelete();
  }

  notifyCreate(): void {
    this.controller?.notifyCreate();
  }

  /** 命令触发的重载；尚未 ready（还没有 controller）时静默返回。 */
  async reloadNow(): Promise<void> {
    if (this.disposed) return;
    await this.controller?.reloadNow();
  }

  setTheme(theme: Theme): void {
    if (this.disposed) return;
    this.currentTheme = theme;
    this.post({ type: 'theme', theme });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.subscription.dispose();
    this.controller?.dispose();
    this.controller = undefined;
    // 编辑器关闭时把节流窗口里的最后状态落盘；不阻塞 dispose。
    void this.options.pageState.flush?.();
  }

  private handleMessage(message: unknown): void {
    if (this.disposed || !isWebviewToHost(message)) return;
    const fromWebview: WebviewToHost = message;
    switch (fromWebview.type) {
      case 'ready':
        if (this.ready) return;
        this.ready = true;
        void this.initialize();
        return;
      case 'page': {
        // 兼容旧 webview：只更新页码，保留已存坐标与缩放。
        const current = this.options.pageState.get(
          this.options.uri,
          this.options.initialViewState,
        );
        this.options.pageState.set(this.options.uri, { ...current, page: fromWebview.page });
        return;
      }
      case 'viewState':
        this.options.pageState.set(this.options.uri, {
          v: 1,
          page: fromWebview.page,
          x: fromWebview.x,
          y: fromWebview.y,
          zoom: fromWebview.zoom,
        });
        return;
      case 'retry':
        void this.controller?.reloadNow();
        return;
      case 'error':
        if (fromWebview.kind === 'render') {
          this.controller?.handleRenderFailure();
        }
        return;
      default:
        return;
    }
  }

  private async initialize(): Promise<void> {
    const { uri, name, initialViewState, readFile, pageState } = this.options;
    const viewState = pageState.get(uri, initialViewState);
    this.post({
      type: 'init',
      uri,
      name,
      page: viewState.page,
      viewState,
      theme: this.currentTheme,
    });

    let initialRevision = 0;
    try {
      const bytes = await readFile();
      if (this.disposed) return;
      initialRevision = 1;
      this.postDocument(bytes, 1);
    } catch (error) {
      if (this.disposed) return;
      this.post({ type: 'error', kind: 'read', message: errorMessage(error) });
    }

    if (this.disposed) return;
    this.controller = this.options.createController({
      readFile,
      onBytes: (bytes, revision) => this.postDocument(bytes, revision),
      onError: (kind, message) => this.post({ type: 'error', kind, message }),
      initialRevision,
    });
  }

  private postDocument(bytes: Uint8Array, revision: number): void {
    if (this.disposed) return;
    const viewState = this.options.pageState.get(
      this.options.uri,
      this.options.initialViewState,
    );
    this.post({
      type: 'document',
      bytes: toArrayBuffer(bytes),
      page: viewState.page,
      viewState,
      revision,
    });
  }

  private post(message: HostToWebview): void {
    if (this.disposed) return;
    void this.options.port.postMessage(message);
  }
}
