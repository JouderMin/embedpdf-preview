import type { HostToWebview, Theme, WebviewToHost } from '../shared/protocol';
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
  readonly initialPage: number;
  readonly readFile: () => Promise<Uint8Array>;
  readonly pageState: {
    get(key: string, fallback: number): number;
    set(key: string, page: number): void;
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
      case 'page':
        this.options.pageState.set(this.options.uri, fromWebview.page);
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
    const { uri, name, initialPage, readFile, pageState } = this.options;
    this.post({
      type: 'init',
      uri,
      name,
      page: pageState.get(uri, initialPage),
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
    this.post({
      type: 'document',
      bytes: toArrayBuffer(bytes),
      page: this.options.pageState.get(this.options.uri, this.options.initialPage),
      revision,
    });
  }

  private post(message: HostToWebview): void {
    if (this.disposed) return;
    void this.options.port.postMessage(message);
  }
}
