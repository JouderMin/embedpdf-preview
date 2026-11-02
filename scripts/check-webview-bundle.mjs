import { readFileSync } from 'node:fs';

const file = process.argv[2] ?? 'dist/webview.js';
const source = readFileSync(file, 'utf8');

/**
 * 把字符串、模板字符串与注释替换成空格，保留换行与下标。这样不会把
 * `"single process."` 之类文案误判成代码，同时行列号仍可对应原文件。
 */
function maskNonCode(text) {
  const chars = text.split('');
  const length = text.length;
  let i = 0;

  while (i < length) {
    const char = text[i];

    if (char === '/' && text[i + 1] === '/') {
      chars[i] = ' ';
      chars[i + 1] = ' ';
      i += 2;
      while (i < length && text[i] !== '\n') {
        chars[i] = ' ';
        i++;
      }
      continue;
    }

    if (char === '/' && text[i + 1] === '*') {
      chars[i] = ' ';
      chars[i + 1] = ' ';
      i += 2;
      while (i < length && !(text[i] === '*' && text[i + 1] === '/')) {
        if (text[i] !== '\n') {
          chars[i] = ' ';
        }
        i++;
      }
      if (i < length) {
        chars[i] = ' ';
        chars[i + 1] = ' ';
        i += 2;
      }
      continue;
    }

    if (char === "'" || char === '"' || char === '`') {
      const quote = char;
      chars[i] = ' ';
      i++;
      while (i < length) {
        if (text[i] === '\\') {
          chars[i] = ' ';
          if (i + 1 < length) {
            chars[i + 1] = ' ';
          }
          i += 2;
          continue;
        }
        if (text[i] === quote) {
          chars[i] = ' ';
          i++;
          break;
        }
        if (text[i] !== '\n') {
          chars[i] = ' ';
        }
        i++;
      }
      continue;
    }

    i++;
  }

  return chars.join('');
}

const code = maskNonCode(source);

/**
 * 浏览器 webview 里没有 Node 全局。`process.env.NODE_ENV` 必须由 Vite define
 * 在编译期替换；这里兜底扫描产物，防止回归。
 *
 * 只报“未受保护”的引用：React/PDFium 里存在 `typeof process == 'object' &&
 * process.emit(...)` 这类安全分支，`typeof` 检查会短路，不触发 ReferenceError。
 * 对象属性（`state.global.add`）不算全局引用。
 */
const checks = [
  { name: 'process', pattern: /(?<![.\w$])process\./g, allowTypeofGuard: true },
  { name: 'global', pattern: /(?<![.\w$])global\./g, allowTypeofGuard: true },
  { name: 'Buffer', pattern: /(?<![.\w$])Buffer\./g, allowTypeofGuard: false },
  { name: '__dirname', pattern: /(?<![.\w$])__dirname\b/g, allowTypeofGuard: false },
  { name: '__filename', pattern: /(?<![.\w$])__filename\b/g, allowTypeofGuard: false },
];

const findings = [];
const guarded = [];

for (const { name, pattern, allowTypeofGuard } of checks) {
  for (const match of code.matchAll(pattern)) {
    const index = match.index ?? 0;
    const before = code.slice(Math.max(0, index - 200), index);
    // 同一句里的 typeof process 检查才能短路；上一条语句里的检查不算。
    const currentStatement = before.slice(before.lastIndexOf(';') + 1);
    const hasTypeofGuard = new RegExp(`typeof\\s+${name}\\b`).test(currentStatement);
    // process.env 即使有 typeof 守卫也要求编译期替换，不能留给浏览器。
    const isEnv = name === 'process' && code.slice(index, index + 11) === 'process.env';
    if (allowTypeofGuard && hasTypeofGuard && !isEnv) {
      guarded.push({ name, index });
      continue;
    }
    const line = source.slice(0, index).split('\n').length;
    const lastNewline = source.lastIndexOf('\n', index);
    const column = index - lastNewline;
    findings.push({
      name,
      line,
      column,
      excerpt: source.slice(Math.max(0, index - 40), index + 60).replace(/\s+/g, ' '),
    });
  }
}

if (findings.length > 0) {
  console.error(`check-webview-bundle: ${file} 含未受保护的 Node 全局引用`);
  for (const finding of findings) {
    console.error(
      `  ${finding.name} at ${finding.line}:${finding.column}  ...${finding.excerpt}...`,
    );
  }
  process.exit(1);
}

const summary = checks
  .map(({ name }) => {
    const guardedCount = guarded.filter((item) => item.name === name).length;
    return guardedCount > 0 ? `${name}: ${guardedCount} guarded` : `${name}: 0`;
  })
  .join(', ');
const bytes = Buffer.byteLength(source, 'utf8');
console.log(`check-webview-bundle: OK (${file}, ${bytes} bytes) — ${summary}`);
