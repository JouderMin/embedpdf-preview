import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import type { Theme } from '../shared/protocol';
import { PageState } from './pageState';
import { ReloadController } from './reloadController';
import { WATCH_GLOB, isSameWatchTarget } from './watchTarget';
import { renderHtml } from './webviewHtml';
import { WebviewSession } from './webviewSession';

function createNonce(): string {
  return randomBytes(16).toString('base64');
}

function currentTheme(): Theme {
  const kind = vscode.window.activeColorTheme.kind;
  return kind === vscode.ColorThemeKind.Dark || kind === vscode.ColorThemeKind.HighContrast
    ? 'dark'
    : 'light';
}

function directoryOf(uri: vscode.Uri): vscode.Uri {
  const slash = uri.path.lastIndexOf('/');
  return uri.with({ path: slash <= 0 ? '/' : uri.path.slice(0, slash) });
}

function fileNameOf(uri: vscode.Uri): string {
  const slash = uri.path.lastIndexOf('/');
  return uri.path.slice(slash + 1) || 'document.pdf';
}

/**
 * 为每个 PDF 编辑器创建 webview 会话，并监听所在目录中该文件的变化。
 * 注册选项（retainContextWhenHidden / supportsMultipleEditorsPerDocument）
 * 由调用方在 extension.ts 中提供。
 */
export class PdfPreviewProvider implements vscode.CustomReadonlyEditorProvider {
  static readonly viewType = 'embedpdf.preview';

  private readonly pageState: PageState;
  private readonly sessions = new Map<string, WebviewSession>();
  private activeKey: string | undefined;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.pageState = new PageState(context.globalState);
  }

  /** 重载当前聚焦的预览；没有活动预览时返回 false。 */
  reloadActive(): boolean {
    const session = this.activeKey ? this.sessions.get(this.activeKey) : undefined;
    if (!session) {
      return false;
    }
    void session.reloadNow();
    return true;
  }

  /** 主题变化对所有打开的预览生效。 */
  setTheme(theme: Theme): void {
    for (const session of this.sessions.values()) {
      session.setTheme(theme);
    }
  }

  async openCustomDocument(
    uri: vscode.Uri,
    _openContext: vscode.CustomDocumentOpenContext,
    _token: vscode.CancellationToken,
  ): Promise<vscode.CustomDocument> {
    return { uri, dispose: () => undefined };
  }

  async resolveCustomEditor(
    document: vscode.CustomDocument,
    panel: vscode.WebviewPanel,
    _token: vscode.CancellationToken,
  ): Promise<void> {
    const mediaRoot = vscode.Uri.joinPath(this.context.extensionUri, 'dist');
    panel.webview.options = {
      enableScripts: true,
      localResourceRoots: [mediaRoot],
    };
    panel.webview.html = renderHtml({
      cspSource: panel.webview.cspSource,
      scriptUri: panel.webview
        .asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'webview.js'))
        .toString(),
      styleUri: panel.webview
        .asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'webview.css'))
        .toString(),
      nonce: createNonce(),
    });

    const uri = document.uri;
    const key = uri.toString();
    const session = new WebviewSession({
      uri: key,
      name: fileNameOf(uri),
      initialPage: this.pageState.get(key, 1),
      readFile: () => Promise.resolve(vscode.workspace.fs.readFile(uri)),
      pageState: {
        get: (pageKey, fallback) => this.pageState.get(pageKey, fallback),
        set: (pageKey, page) => this.pageState.set(pageKey, page),
      },
      theme: currentTheme,
      port: {
        postMessage: (message) => panel.webview.postMessage(message),
        onMessage: (handler) =>
          panel.webview.onDidReceiveMessage((message) => handler(message)),
      },
      createController: (options) => new ReloadController(options),
    });

    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(directoryOf(uri), WATCH_GLOB),
    );
    const targetUri = key;
    const fileSubscriptions = [
      watcher.onDidChange((event) => {
        if (isSameWatchTarget(event.toString(), targetUri)) {
          session.notifyChange();
        }
      }),
      watcher.onDidDelete((event) => {
        if (isSameWatchTarget(event.toString(), targetUri)) {
          session.notifyDelete();
        }
      }),
      watcher.onDidCreate((event) => {
        if (isSameWatchTarget(event.toString(), targetUri)) {
          session.notifyCreate();
        }
      }),
    ];
    const viewStateSubscription = panel.onDidChangeViewState((event) => {
      if (event.webviewPanel.active) {
        this.activeKey = key;
      }
    });

    this.sessions.set(key, session);
    if (panel.active) {
      this.activeKey = key;
    }

    panel.onDidDispose(() => {
      this.sessions.delete(key);
      if (this.activeKey === key) {
        this.activeKey = undefined;
      }
      session.dispose();
      watcher.dispose();
      viewStateSubscription.dispose();
      for (const subscription of fileSubscriptions) {
        subscription.dispose();
      }
    });
  }
}
