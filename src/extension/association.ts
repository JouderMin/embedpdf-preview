export const ASSOCIATION_KEY = 'workbench.editorAssociations';
export const SET_DEFAULT_COMMAND = 'embedpdf.setAsDefault';
export const RELOAD_COMMAND = 'embedpdf.reload';
export const ASSOCIATION_NOTIFIED_KEY = 'embedpdf.associationNotified';

export type AssociationMap = Record<string, unknown>;

export interface SetAsDefaultDeps {
  read(): AssociationMap;
  update(value: AssociationMap): PromiseLike<unknown> | Promise<unknown> | void;
  confirm(): Promise<boolean> | boolean;
}

export interface NotifyMissingAssociationDeps {
  read(): AssociationMap;
  notified(): boolean;
  markNotified(): PromiseLike<unknown> | Promise<unknown> | void;
  notify(): PromiseLike<unknown> | Promise<unknown> | void;
}

/** 写入 editorAssociations 的条目。 */
export function associationEntry(): Record<string, string> {
  return { '*.pdf': 'embedpdf.preview' };
}

/** 当前 `*.pdf` 是否已精确指向本扩展。 */
export function isAssociatedToUs(read: () => AssociationMap): boolean {
  return read()['*.pdf'] === 'embedpdf.preview';
}

/**
 * 先确认再合并写入，保留用户已有的其他扩展名关联。
 * 返回是否真的写入。
 */
export async function setAsDefault(deps: SetAsDefaultDeps): Promise<boolean> {
  const confirmed = await deps.confirm();
  if (!confirmed) {
    return false;
  }
  await deps.update({ ...deps.read(), ...associationEntry() });
  return true;
}

/** 扩展激活时最多提示一次；已关联或已提示过则什么也不做。 */
export async function notifyMissingAssociationOnce(
  deps: NotifyMissingAssociationDeps,
): Promise<void> {
  if (isAssociatedToUs(deps.read) || deps.notified()) {
    return;
  }
  await deps.notify();
  await deps.markNotified();
}
