import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import type { Theme } from '../shared/protocol';
import { PageState } from './pageState';
import { ReloadController } from './reloadController';
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

  constructor(private readonly context: vscode.ExtensionContext) {
    this.pageState = new PageState(context.globalState);
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
      new vscode.RelativePattern(directoryOf(uri), fileNameOf(uri)),
    );
    const fileSubscriptions = [
      watcher.onDidChange(() => session.notifyChange()),
      watcher.onDidDelete(() => session.notifyDelete()),
      watcher.onDidCreate(() => session.notifyCreate()),
    ];
    panel.onDidDispose(() => {
      session.dispose();
      watcher.dispose();
      for (const subscription of fileSubscriptions) {
        subscription.dispose();
      }
    });
  }
}
