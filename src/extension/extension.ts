import * as vscode from 'vscode';
import type { Theme } from '../shared/protocol';
import {
  ASSOCIATION_KEY,
  ASSOCIATION_NOTIFIED_KEY,
  RELOAD_COMMAND,
  SET_DEFAULT_COMMAND,
  notifyMissingAssociationOnce,
  setAsDefault,
  type AssociationMap,
} from './association';
import { PdfPreviewProvider } from './pdfEditorProvider';

function currentTheme(): Theme {
  const kind = vscode.window.activeColorTheme.kind;
  return kind === vscode.ColorThemeKind.Dark || kind === vscode.ColorThemeKind.HighContrast
    ? 'dark'
    : 'light';
}

function readAssociations(): AssociationMap {
  return vscode.workspace
    .getConfiguration()
    .get<AssociationMap>(ASSOCIATION_KEY, {});
}

function updateAssociations(value: AssociationMap): Thenable<void> {
  return vscode.workspace
    .getConfiguration()
    .update(ASSOCIATION_KEY, value, vscode.ConfigurationTarget.Global);
}

async function confirmSetDefault(): Promise<boolean> {
  const choice = await vscode.window.showInformationMessage(
    '将 PDF 预览设为默认会改变其他 PDF 扩展的打开行为，继续？',
    { modal: true },
    '设为默认',
  );
  return choice === '设为默认';
}

export function activate(context: vscode.ExtensionContext): void {
  const provider = new PdfPreviewProvider(context);
  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(PdfPreviewProvider.viewType, provider, {
      webviewOptions: { retainContextWhenHidden: true },
      supportsMultipleEditorsPerDocument: false,
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(RELOAD_COMMAND, () => {
      if (!provider.reloadActive()) {
        void vscode.window.showInformationMessage('没有打开的 PDF 预览');
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(SET_DEFAULT_COMMAND, async () => {
      await setAsDefault({
        read: readAssociations,
        update: updateAssociations,
        confirm: confirmSetDefault,
      });
    }),
  );

  context.subscriptions.push(
    vscode.window.onDidChangeActiveColorTheme(() => provider.setTheme(currentTheme())),
  );

  void notifyMissingAssociationOnce({
    read: readAssociations,
    notified: () => context.globalState.get<boolean>(ASSOCIATION_NOTIFIED_KEY, false),
    markNotified: () => context.globalState.update(ASSOCIATION_NOTIFIED_KEY, true),
    notify: async () => {
      await vscode.window.showInformationMessage('PDF 预览已安装，设为默认？');
    },
  });
}

export function deactivate(): void {
  // 订阅随 context.subscriptions 一起释放。
}
