/**
 * 目录监听使用 `*` 而不是文件名：文件名里的 `[`、`]`、`?`、`*`、`{`、`}`
 * 会被 VS Code 当成 glob 元字符，直接作为 RelativePattern 的文件名会让这些
 * 文件静默失去监听。事件到达后再按 URI 字符串精确比较。
 */
export const WATCH_GLOB = '*';

export function isSameWatchTarget(candidate: string, target: string): boolean {
  return candidate === target;
}
