import { describe, expect, test, vi } from 'vitest';
import {
  associationEntry,
  isAssociatedToUs,
  notifyMissingAssociationOnce,
  setAsDefault,
} from '../src/extension/association';

describe('associationEntry', () => {
  test('固定把 *.pdf 指向本扩展', () => {
    expect(associationEntry()).toEqual({ '*.pdf': 'embedpdf.preview' });
  });
});

describe('isAssociatedToUs', () => {
  test('只有 *.pdf 精确指向本扩展才算已关联', () => {
    expect(isAssociatedToUs(() => ({ '*.pdf': 'embedpdf.preview' }))).toBe(true);
    expect(isAssociatedToUs(() => ({ '*.pdf': 'mathematic.vscode-pdf' }))).toBe(false);
    expect(isAssociatedToUs(() => ({}))).toBe(false);
  });
});

describe('setAsDefault', () => {
  test('合并写入，保留其他扩展名', async () => {
    const read = () => ({ '*.foo': 'x' });
    const update = vi.fn(async () => {});
    const confirm = vi.fn(async () => true);
    await expect(setAsDefault({ read, update, confirm })).resolves.toBe(true);
    expect(update).toHaveBeenCalledWith({ '*.foo': 'x', '*.pdf': 'embedpdf.preview' });
  });

  test('用户取消则不写入', async () => {
    const read = () => ({});
    const update = vi.fn(async () => {});
    const confirm = vi.fn(async () => false);
    await expect(setAsDefault({ read, update, confirm })).resolves.toBe(false);
    expect(update).not.toHaveBeenCalled();
  });

  test('已有其他扩展名时仍只覆盖 *.pdf', async () => {
    const read = () => ({ '*.pdf': 'other', '*.tex': 'latex' });
    const update = vi.fn(async () => {});
    await setAsDefault({ read, update, confirm: async () => true });
    expect(update).toHaveBeenCalledWith({
      '*.pdf': 'embedpdf.preview',
      '*.tex': 'latex',
    });
  });
});

describe('notifyMissingAssociationOnce', () => {
  test('已关联时不重复通知', async () => {
    const notify = vi.fn(async () => {});
    const markNotified = vi.fn(async () => {});
    await notifyMissingAssociationOnce({
      read: () => ({ '*.pdf': 'embedpdf.preview' }),
      notified: () => false,
      markNotified,
      notify,
    });
    expect(notify).not.toHaveBeenCalled();
    expect(markNotified).not.toHaveBeenCalled();
  });

  test('未关联时只通知一次', async () => {
    let notified = false;
    const notify = vi.fn(async () => {});
    const markNotified = vi.fn(async () => {
      notified = true;
    });
    const deps = {
      read: () => ({}),
      notified: () => notified,
      markNotified,
      notify,
    };

    await notifyMissingAssociationOnce(deps);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(markNotified).toHaveBeenCalledTimes(1);

    await notifyMissingAssociationOnce(deps);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(markNotified).toHaveBeenCalledTimes(1);
  });
});
