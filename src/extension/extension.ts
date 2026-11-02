import * as vscode from 'vscode';
import { PdfPreviewProvider } from './pdfEditorProvider';

export function activate(context: vscode.ExtensionContext): void {
  const provider = new PdfPreviewProvider(context);
  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(PdfPreviewProvider.viewType, provider, {
      webviewOptions: { retainContextWhenHidden: true },
      supportsMultipleEditorsPerDocument: false,
    }),
  );
}

export function deactivate(): void {
  // 订阅随 context.subscriptions 一起释放。
}
