import { describe, expect, test } from 'vitest';
import { WATCH_GLOB, isSameWatchTarget } from '../src/extension/watchTarget';

describe('watchTarget', () => {
  test('watcher 用 * 监听目录，再按 URI 字面过滤', () => {
    expect(WATCH_GLOB).toBe('*');
  });

  test('文件名里的 glob 字符不会扩大匹配范围', () => {
    const target = 'file:///tmp/report%5B1%5D.pdf';
    expect(isSameWatchTarget(target, target)).toBe(true);

    // 这些近邻 URI 若被当成 glob 或前缀匹配就会误命中。
    for (const candidate of [
      'file:///tmp/report1.pdf',
      'file:///tmp/report%5B1%5D.pdf.bak',
      'file:///tmp/report%5B1%5D.pdf/child',
      'file:///tmp/report%5B10%5D.pdf',
      'file:///tmp/REPORT%5B1%5D.pdf',
      'file:///tmp/report[1].pdf',
      'file:///other/report%5B1%5D.pdf',
    ]) {
      expect(isSameWatchTarget(candidate, target)).toBe(false);
    }

    expect(isSameWatchTarget('file:///tmp/a%20b.pdf', 'file:///tmp/a b.pdf')).toBe(false);

    for (const name of ['a?b.pdf', 'x*y.pdf', '{draft}.pdf']) {
      const uri = `file:///tmp/${encodeURIComponent(name)}`;
      expect(isSameWatchTarget(uri, uri)).toBe(true);
      expect(isSameWatchTarget(`file:///tmp/${encodeURIComponent(`copy-${name}`)}`, uri)).toBe(
        false,
      );
    }
  });
});
