import { describe, expect, test } from 'vitest';
import { WATCH_GLOB, isSameWatchTarget } from '../src/extension/watchTarget';

describe('watchTarget', () => {
  test('watcher 用 * 监听目录，再按 URI 字面过滤', () => {
    expect(WATCH_GLOB).toBe('*');
  });

  test('文件名里的 glob 字符不影响精确匹配', () => {
    for (const name of ['report[1].pdf', 'a?b.pdf', 'x*y.pdf', '{draft}.pdf']) {
      const target = `file:///tmp/${encodeURIComponent(name)}`;
      expect(isSameWatchTarget(target, target)).toBe(true);
      expect(isSameWatchTarget(`file:///tmp/${encodeURIComponent(`copy-${name}`)}`, target)).toBe(
        false,
      );
    }
  });
});
