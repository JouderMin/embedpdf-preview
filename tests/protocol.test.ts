import { describe, expect, test } from 'vitest';
import { isWebviewToHost } from '../src/shared/protocol';

describe('isWebviewToHost', () => {
  test('接受合法消息', () => {
    expect(isWebviewToHost({ type: 'ready' })).toBe(true);
    expect(isWebviewToHost({ type: 'page', page: 3 })).toBe(true);
    expect(isWebviewToHost({ type: 'retry' })).toBe(true);
    expect(isWebviewToHost({ type: 'error', kind: 'render', message: 'x' })).toBe(true);
    expect(isWebviewToHost({ type: 'error', kind: 'read', message: '' })).toBe(true);
  });

  test('拒绝非法消息', () => {
    expect(isWebviewToHost(null)).toBe(false);
    expect(isWebviewToHost(undefined)).toBe(false);
    expect(isWebviewToHost('ready')).toBe(false);
    expect(isWebviewToHost([])).toBe(false);
    expect(isWebviewToHost({ type: 'page' })).toBe(false);
    expect(isWebviewToHost({ type: 'page', page: '3' })).toBe(false);
    expect(isWebviewToHost({ type: 'page', page: Number.NaN })).toBe(false);
    expect(isWebviewToHost({ type: 'page', page: 1.5 })).toBe(false);
    expect(isWebviewToHost({ type: 'nope' })).toBe(false);
    expect(isWebviewToHost({ type: 'error', kind: 'render' })).toBe(false);
    expect(isWebviewToHost({ type: 'error', kind: 'other', message: 'x' })).toBe(false);
  });
});
