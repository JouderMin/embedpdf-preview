# EmbedPDF VS Code 预览扩展实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 做一个 VS Code 扩展，双击 `.pdf` 用 EmbedPDF 预览，文件变化后重载并回到原页。

**Architecture:** 扩展端（Node）用 `CustomReadonlyEditorProvider` 管 webview、读文件字节、监听文件系统；webview 端（浏览器）用 React 挂官方 `PDFViewer`，收到字节后走 `document-manager` 换文档、`scroll` 跳页。两端只通过 `postMessage` 消息协议通信。

**Tech Stack:** TypeScript、rolldown、Vite、React、`@embedpdf/react-pdf-viewer`、vitest。

说明：计划写于 2026-11-02，构建链后续有过两次调整，以设计文档为准：扩展端打包由 esbuild 改为 rolldown（t17），Vite 升到 8 并改用 rolldown/oxc 内核。

**Spec:** `docs/superpowers/specs/2026-11-02-embed-pdf-vscode-preview-design.md`

## Global Constraints

- VS Code `^1.85.0`，Node.js 20。
- 离线：不请求 CDN。`pdfium.wasm` 与字体从 `media/` 加载；CSP 只放 `cspSource`。
- 验收文档 20 页以内、5 MB 以内；“1 秒”从保存事件算到跳页完成。
- 路径含中文，按 URI 处理，不做 ASCII 假设。
- 每个 URI 只允许一个预览视图（`supportsMultipleEditorsPerDocument: false`）。
- 只读：不写回 PDF，关闭批注、表单、签名、打印、导出。
- 构建产物文件名固定：`dist/webview.js`、`dist/webview.css`。
- 单元测试只测纯逻辑；VS Code 集成与界面走手工清单。

## Review Focus

1. 中文与空格路径：`file://` URI 带 `%E5%…`，页码键与 watcher 路径都要能往返。Task 2、Task 5。
2. 半写或损坏的 PDF：`openDocumentBuffer` 可能抛错，也可能返回 0 页。必须回滚到旧文档，不显示空白。Task 6。
3. 删除后快速重建（`latexmk` 改名替换、`git checkout`）：不得闪“文件已删除”。Task 4。
4. 新文档页数少于原页码（原页 9，新文档 3 页）：跳到末页，不报错。Task 6。
5. 未设默认关联时双击被其他扩展接走：命令与一次性通知仍可用；同一文件拆分视图只聚焦已有编辑器。Task 7 与手工清单。

---

### Task 1: 扩展骨架与清单

**Files:**
- Create: `package.json`、`tsconfig.json`、`vitest.config.ts`、`vite.config.ts`、`scripts/build-extension.mjs`、`scripts/copy-assets.mjs`、`src/extension/extension.ts`、`tests/manifest.test.ts`
- Test: `tests/manifest.test.ts`

**Interfaces:**
- Consumes: 无
- Produces: `package.json` 的 `contributes.customEditors[0].viewType = "embedpdf.preview"`；`activate(context: vscode.ExtensionContext): void`；命令 id `embedpdf.reload`、`embedpdf.setAsDefault`；脚本 `build`、`watch`、`test`、`package`。

- [ ] **Step 1: 写失败的清单测试**

```ts
import { readFileSync } from 'node:fs';
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));

test('注册自定义编辑器，只按扩展名匹配', () => {
  const editor = pkg.contributes.customEditors[0];
  expect(editor.viewType).toBe('embedpdf.preview');
  expect(editor.selector).toEqual([{ filenamePattern: '*.pdf' }]);
  expect(editor.priority).toBe('option');
});

test('激活事件与命令齐全', () => {
  expect(pkg.activationEvents).toEqual(
    expect.arrayContaining(['onStartupFinished', 'onCustomEditor:embedpdf.preview'])
  );
  const ids = pkg.contributes.commands.map((c: { command: string }) => c.command);
  expect(ids).toEqual(expect.arrayContaining(['embedpdf.reload', 'embedpdf.setAsDefault']));
  expect(pkg.engines.vscode).toBe('^1.85.0');
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `pnpm exec vitest run tests/manifest.test.ts`
Expected: FAIL，`Cannot find module 'package.json'` 或 `customEditors` 为 undefined。

- [ ] **Step 3: 建立骨架**

`package.json`：名字 `embedpdf-preview`，`main: "./dist/extension.js"`，`engines.vscode: "^1.85.0"`，`activationEvents` 见上，`contributes.customEditors` 与 `contributes.commands`（`embedpdf.reload` 标题“重载预览”，`embedpdf.setAsDefault` 标题“将 PDF 预览设为默认”）。`priority` 用 `option`，理由：不抢其他扩展，默认关联交给命令。

依赖：`@embedpdf/react-pdf-viewer`、`@embedpdf/pdfium`、`@embedpdf/fonts-sc`、`@embedpdf/fonts-latin`、`react`、`react-dom`；devDependencies：`typescript`、`rolldown`、`vite`、`@vitejs/plugin-react`、`vitest`、`@types/vscode@1.85.0`、`@types/react`、`@types/react-dom`、`@vscode/vsce`。

`src/extension/extension.ts` 先只导出 `activate` 与 `deactivate`，体内留空并加 `// filled by later tasks`。

`scripts/build-extension.mjs`：rolldown 打包 `src/extension/extension.ts` → `dist/extension.js`，平台 node、`format: 'cjs'`、`external: ['vscode']`、目标 node20。`scripts/copy-assets.mjs`：复制 `node_modules/@embedpdf/pdfium/dist/pdfium.wasm` 到 `dist/media/pdfium.wasm`，复制 `@embedpdf/fonts-sc` 与 `@embedpdf/fonts-latin` 的全部 `.otf`/`.ttf` 到 `dist/media/fonts/`；文件不存在时以非 0 退出并打印缺失路径。

`vitest.config.ts`：`environment: 'node'`，`include: ['tests/**/*.test.ts']`。

- [ ] **Step 4: 运行测试与构建**

Run: `pnpm exec vitest run tests/manifest.test.ts && pnpm run build`
Expected: 测试 PASS；构建退出码 0，`dist/extension.js` 与 `dist/media/` 存在。

- [ ] **Step 5: 提交**

```bash
git add -A && git commit -m "feat: 扩展骨架、清单与构建脚本"
```

### Task 2: 消息协议与页码状态

**Files:**
- Create: `src/shared/protocol.ts`、`src/extension/pageState.ts`、`tests/protocol.test.ts`、`tests/pageState.test.ts`
- Test: `tests/protocol.test.ts`、`tests/pageState.test.ts`

**Interfaces:**
- Consumes: 无
- Produces:

```ts
// src/shared/protocol.ts
export type Theme = 'light' | 'dark';
export type HostToWebview =
  | { type: 'init'; uri: string; name: string; page: number; theme: Theme }
  | { type: 'document'; bytes: ArrayBuffer; page: number; revision: number }
  | { type: 'theme'; theme: Theme }
  | { type: 'error'; kind: 'read' | 'render'; message: string };
export type WebviewToHost =
  | { type: 'ready' }
  | { type: 'page'; page: number }
  | { type: 'retry' }
  | { type: 'error'; kind: 'read' | 'render'; message: string };
export function isWebviewToHost(value: unknown): value is WebviewToHost;

// src/extension/pageState.ts
export const PAGE_KEY_PREFIX = 'embedpdf.page.';
export function pageKey(uri: string): string;
export interface MementoLike { get<T>(key: string, def: T): T; update(key: string, value: unknown): Promise<void>; }
export class PageState {
  constructor(store: MementoLike, throttleMs?: number); // 默认 500
  get(uri: string, fallback: number): number;  // 返回 >=1 的整数
  set(uri: string, page: number): void;        // 节流写入，只保留最后一页
  flush(): Promise<void>;
}
```

- [ ] **Step 1: 写失败的测试**

```ts
// tests/protocol.test.ts
import { isWebviewToHost } from '../src/shared/protocol';
test('接受合法消息', () => {
  expect(isWebviewToHost({ type: 'ready' })).toBe(true);
  expect(isWebviewToHost({ type: 'page', page: 3 })).toBe(true);
  expect(isWebviewToHost({ type: 'retry' })).toBe(true);
  expect(isWebviewToHost({ type: 'error', kind: 'render', message: 'x' })).toBe(true);
});
test('拒绝非法消息', () => {
  expect(isWebviewToHost(null)).toBe(false);
  expect(isWebviewToHost({ type: 'page' })).toBe(false);
  expect(isWebviewToHost({ type: 'page', page: '3' })).toBe(false);
  expect(isWebviewToHost({ type: 'nope' })).toBe(false);
});

// tests/pageState.test.ts 关键断言
test('键按原 URI 拼接，中文与空格不丢', () => {
  expect(pageKey('file:///Volumes/%E5%A4%96%E7%BD%AE/a%20b.pdf'))
    .toBe('embedpdf.page.file:///Volumes/%E5%A4%96%E7%BD%AE/a%20b.pdf');
});
test('get 夹到 >=1 的整数', () => {
  const state = new PageState(store);
  expect(state.get(uri, 1)).toBe(1);                 // 空值用兜底
  expect(state.get(uri, 1)).toBe(1);                 // 存 0 也返回 1
  expect(state.get(uri, 1)).toBe(2);                 // 存 2.7 返回 2 或 3，实现取整
});
test('set 节流，只写最后一页', async () => {
  vi.useFakeTimers();
  const state = new PageState(store, 500);
  state.set(uri, 3); state.set(uri, 4); state.set(uri, 5);
  expect(store.update).not.toHaveBeenCalled();
  vi.advanceTimersByTime(500);
  expect(store.update).toHaveBeenCalledTimes(1);
  expect(store.update).toHaveBeenCalledWith(pageKey(uri), 5);
});
test('flush 立即写，无待写则不调用', async () => {
  const state = new PageState(store);
  state.set(uri, 7);
  await state.flush();
  expect(store.update).toHaveBeenCalledWith(pageKey(uri), 7);
  store.update.mockClear();
  await state.flush();
  expect(store.update).not.toHaveBeenCalled();
});
```

`store` 用 `{ get: vi.fn(() => undefined), update: vi.fn(async () => {}) }` 并允许逐例改 `get` 返回值。

- [ ] **Step 2: 运行，确认失败**

Run: `pnpm exec vitest run tests/protocol.test.ts tests/pageState.test.ts`
Expected: FAIL，模块不存在。

- [ ] **Step 3: 写最小代码**

`isWebviewToHost` 严格按字段类型判断，不信任 `kind`/`page` 的松散值。`PageState` 用 `setTimeout` 节流；`get` 用 `Math.max(1, Math.trunc(Number(v)))`，非有限数回落 `fallback`。

- [ ] **Step 4: 运行，确认通过**

Run: `pnpm exec vitest run tests/protocol.test.ts tests/pageState.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add -A && git commit -m "feat: 消息协议与页码持久化"
```

### Task 3: webview 配置与 HTML

**Files:**
- Create: `src/webview/viewerConfig.ts`、`src/extension/webviewHtml.ts`、`tests/viewerConfig.test.ts`、`tests/webviewHtml.test.ts`
- Test: 同上

**Interfaces:**
- Consumes: `Theme`（Task 2）
- Produces:

```ts
// src/webview/viewerConfig.ts
export const DISABLED_CATEGORIES: readonly string[];
export interface ViewerConfigInput { theme: 'light' | 'dark'; wasmUrl: string; fontBaseUrl: string; }
export function createViewerConfig(input: ViewerConfigInput): PdfViewerConfig;

// src/extension/webviewHtml.ts
export interface HtmlInput { cspSource: string; scriptUri: string; styleUri: string; nonce: string; }
export function renderHtml(input: HtmlInput): string;
```

- [ ] **Step 1: 核实包内事实**

Run: `pnpm install`，然后：

```bash
grep -Rho "document-capture\|document-print\|annotation[^\"']*\|redaction[^\"']*" node_modules/@embedpdf/{snippet,plugin-*}/dist 2>/dev/null | sort -u | head -50
node -e "const t=await import('@embedpdf/react-pdf-viewer'); console.log(Object.keys(t))"
```

目标：得到 `PDFViewerConfig` 的 `theme` 字段形状、`disabledCategories` 的合法值、`fontFallback` 字段名，以及界面字体与印章两个字段（`fonts`、`stamp`）的键名。把结论写进 `src/webview/viewerConfig.ts` 顶部注释（文件、行号或命令）。若 `theme` 不是 `{ colorScheme }`，按实际类型改测试断言。

另需确认 `@embedpdf/snippet` 是否在 `node_modules` 里：pnpm 无幽灵依赖，复制 `pdfium.wasm` 依赖该包。不在就加进 dependencies。

- [ ] **Step 2: 写失败的测试**

```ts
test('关闭写入类与文件类功能，且无重复', () => {
  const set = new Set(DISABLED_CATEGORIES);
  expect(set.size).toBe(DISABLED_CATEGORIES.length);
  for (const name of ['annotation', 'form', 'redaction', 'print', 'export', 'attachment']) {
    expect(set.has(name)).toBe(true);
  }
});
test('配置固定项', () => {
  const config = createViewerConfig({ theme: 'dark', wasmUrl: 'vscode-resource://w', fontBaseUrl: 'vscode-resource://f/' });
  expect(config.worker).toBe(false);
  expect(config.tabBar).toBe('never');
  expect(config.wasmUrl).toBe('vscode-resource://w');
  expect(config.disabledCategories).toEqual([...DISABLED_CATEGORIES]);
  expect(config.fontFallback?.fonts?.GB2312).toEqual([
    { url: 'vscode-resource://f/NotoSansHans-Regular.otf', weight: 400 },
    { url: 'vscode-resource://f/NotoSansHans-Bold.otf', weight: 700 },
  ]);
});
test('配置不含任何外部域名，界面字体与印章已关闭', () => {
  const config = createViewerConfig({ theme: 'light', wasmUrl: 'vscode-resource://w', fontBaseUrl: 'vscode-resource://f/' });
  const text = JSON.stringify(config);
  expect(text).not.toMatch(/googleapis|gstatic|jsdelivr|unpkg|default-stamps/i);
  expect(text).not.toContain('http://');
  expect(text).not.toContain('https://');
});
test('HTML 的 CSP 放开 wasm 与字体，且不放开 https', () => {
  const html = renderHtml({ cspSource: 'vscode-resource://x', scriptUri: 'vscode-resource://x/webview.js', styleUri: 'vscode-resource://x/webview.css', nonce: 'n1' });
  expect(html).toContain("script-src 'nonce-n1' 'wasm-unsafe-eval'");
  expect(html).toContain("font-src vscode-resource://x");
  expect(html).toContain('nonce="n1"');
  expect(html).not.toContain('https:');
});
```

- [ ] **Step 3: 写最小代码**

`viewerConfig` 按核实结果写；字体条目只用 GB2312 的两款与 `CYRILLIC`/`GREEK`/`VIETNAMESE` 复用 `NotoSans-{Regular,Italic,Bold,BoldItalic}.ttf`。界面字体与签名字体设为 `null`（`fonts: { ui: null, signature: null }`，键名按核实结果），印章清单设为空（`stamp: { manifests: [] }`），避免 Google Fonts 与 `@embedpdf/default-stamps` 的外网请求。`renderHtml` 输出 `<div id="root">`、带 nonce 的脚本标签、`font-src` 与 `media-src` 为 `cspSource`。

- [ ] **Step 4: 运行，确认通过**

Run: `pnpm exec vitest run tests/viewerConfig.test.ts tests/webviewHtml.test.ts`
Expected: PASS。若 Step 1 发现分类名不同，先改 `DISABLED_CATEGORIES` 再跑。

- [ ] **Step 5: 提交**

```bash
git add -A && git commit -m "feat: webview 配置与 HTML 模板"
```

### Task 4: 重载状态机

**Files:**
- Create: `src/extension/reloadController.ts`、`tests/reloadController.test.ts`
- Test: `tests/reloadController.test.ts`

**Interfaces:**
- Consumes: 无
- Produces:

```ts
export interface ReloadControllerOptions {
  readFile(): Promise<Uint8Array>;
  onBytes(bytes: Uint8Array, revision: number): void;
  onError(kind: 'read' | 'render', message: string): void;
  debounceMs?: number;      // 默认 300
  deleteGraceMs?: number;   // 默认 1500
  retryDelayMs?: number;    // 默认 200
  maxRetries?: number;      // 默认 3
}
export class ReloadController {
  constructor(options: ReloadControllerOptions);
  notifyChange(): void;
  notifyDelete(): void;
  notifyCreate(): void;
  handleRenderFailure(): void;
  reloadNow(): Promise<void>;
  dispose(): void;
}
```

- [ ] **Step 1: 写失败的测试**

```ts
test('300ms 内多次 change 只读一次', async () => { /* fake timers：3 次 notifyChange，前进 300ms，readFile 1 次 */ });
test('删除后 1400ms 重建不出错，只重载一次', async () => { /* notifyDelete → 前进 1400 → notifyCreate → 前进 300：onError 未调用，onBytes 1 次 */ });
test('删除 1500ms 后仍不存在，报 read', async () => { /* onError('read', …) */ });
test('读取失败重试 3 次后报 read，成功则不报', async () => { /* readFile 先 reject 两次再成功：onBytes 1 次，onError 0 次 */ });
test('渲染失败触发重读，3 次后报 render', async () => { /* handleRenderFailure 链式，末尾 onError('render', …) */ });
test('dispose 后不再读取', async () => { /* notifyChange → dispose → 前进 5s：readFile 0 次 */ });
test('revision 递增', async () => { /* 两次成功重载 revision 为 1、2 */ });
```

- [ ] **Step 2: 运行，确认失败**

Run: `pnpm exec vitest run tests/reloadController.test.ts`
Expected: FAIL，模块不存在。

- [ ] **Step 3: 写最小代码**

去抖与重试共用一组定时器句柄，`dispose` 全部清理。`notifyDelete` 起 1.5 秒计时器；`notifyCreate`/`notifyChange` 取消该计时器并进入去抖。读取成功后 `revision++` 再 `onBytes`。`handleRenderFailure` 走同一重试链，但耗尽后报 `render`。

- [ ] **Step 4: 运行，确认通过**

Run: `pnpm exec vitest run tests/reloadController.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add -A && git commit -m "feat: 重载状态机（去抖、删除宽限、解析重试）"
```

### Task 5: WebviewSession 编排

**Files:**
- Create: `src/extension/webviewSession.ts`、`src/extension/pdfEditorProvider.ts`、`tests/webviewSession.test.ts`
- Test: `tests/webviewSession.test.ts`

**Interfaces:**
- Consumes: `HostToWebview`、`isWebviewToHost`、`PageState`（Task 2）；`ReloadController`、`ReloadControllerOptions`（Task 4）；`renderHtml`、`HtmlInput`（Task 3）
- Produces:

```ts
export interface WebviewPort {
  postMessage(message: unknown): PromiseLike<boolean>;
  onMessage(handler: (message: unknown) => void): { dispose(): void };
}
export interface WebviewSessionOptions {
  uri: string;
  name: string;
  initialPage: number;
  readFile(): Promise<Uint8Array>;
  pageState: { get(uri: string, fallback: number): number; set(uri: string, page: number): void };
  theme(): 'light' | 'dark';
  port: WebviewPort;
  createController(options: ReloadControllerOptions): ReloadController;
}
export class WebviewSession {
  constructor(options: WebviewSessionOptions);
  notifyChange(): void;
  notifyDelete(): void;
  notifyCreate(): void;
  setTheme(theme: 'light' | 'dark'): void;
  dispose(): void;
}

export class PdfPreviewProvider implements vscode.CustomReadonlyEditorProvider {
  static readonly viewType = 'embedpdf.preview';
  constructor(context: vscode.ExtensionContext);
  openCustomDocument(uri: vscode.Uri, openContext: vscode.CustomDocumentOpenContext, token: vscode.CancellationToken): Promise<vscode.CustomDocument>;
  resolveCustomEditor(document: vscode.CustomDocument, panel: vscode.WebviewPanel, token: vscode.CancellationToken): Promise<void>;
}
```

- [ ] **Step 1: 写失败的测试**

```ts
test('ready 后依次收到 init 与 document，并开始监听', async () => { /* 断言 messages[0].type === 'init'，[1].type === 'document'，[1].bytes 长度等于文件长度，[1].page 来自 pageState */ });
test('未 ready 前不发消息', async () => { /* 构造后 messages 为空 */ });
test('page 消息写入页码，非法消息忽略', async () => { /* port.emit({type:'page',page:4}) → pageState.set 调用；emit({type:'x'}) 不抛 */ });
test('渲染失败交给状态机重读', async () => { /* emit({type:'error',kind:'render',message:'m'}) → 注入的 controller.handleRenderFailure 被调用 */ });
test('retry 触发 reloadNow', async () => { /* emit({type:'retry'}) → controller.reloadNow 被调用 */ });
test('setTheme 只发 theme 消息', async () => { /* … type === 'theme' */ });
test('watcher 事件转发到 controller', async () => { /* notifyChange/Delete/Create 各自调用对应方法 */ });
test('dispose 释放消息订阅与 controller', async () => { /* dispose 后 port.emit 不再触发任何调用 */ });
```

`port` 用假的：记录 `postMessage`，`onMessage` 收集 handler 并提供 `emit`。`createController` 返回 `{ notifyChange: vi.fn(), … }` 形状的对象并在需要时手动调用传入的回调。

- [ ] **Step 2: 运行，确认失败**

Run: `pnpm exec vitest run tests/webviewSession.test.ts`
Expected: FAIL，模块不存在。

- [ ] **Step 3: 写最小代码**

`WebviewSession` 在 `ready` 时发 `init`，立即 `readFile()` 发 `document`（revision=1），再用 `createController` 建状态机。`pdfEditorProvider` 把 `panel.webview` 包成 `WebviewPort`；`resolveCustomEditor` 里设 `panel.webview.options.localResourceRoots = [extensionUri/dist]`，`panel.webview.html = renderHtml(…)`，按 URI 目录建 `createFileSystemWatcher` 并在回调里调 `session.notifyChange/Delete/Create`，`dispose` 时释放。`openCustomDocument` 返回最小 `{ uri, dispose() {} }` 对象。

- [ ] **Step 4: 运行，确认通过**

Run: `pnpm exec vitest run tests/webviewSession.test.ts && pnpm exec tsc --noEmit`
Expected: PASS，类型检查无错。

- [ ] **Step 5: 提交**

```bash
git add -A && git commit -m "feat: webview 会话编排与编辑器提供者"
```

### Task 6: webview 换文档与回页

**Files:**
- Create: `src/webview/loadDocument.ts`、`src/webview/bridge.ts`、`src/webview/App.tsx`、`src/webview/main.tsx`、`tests/loadDocument.test.ts`
- Test: `tests/loadDocument.test.ts`

**Interfaces:**
- Consumes: `HostToWebview`、`WebviewToHost`（Task 2）；`createViewerConfig`（Task 3）
- Produces:

```ts
export interface DocumentManagerCapability {
  openDocumentBuffer(options: { buffer: ArrayBuffer; name: string; autoActivate: boolean }): { wait(): Promise<unknown> };
  closeDocument(documentId: string): void;
}
export interface ScrollCapabilityLike {
  forDocument(documentId: string): {
    getCurrentPage(): number;
    scrollToPage(options: { pageNumber: number; behavior: 'instant' }): Promise<void>;
  };
  onLayoutReady(handler: (event: { documentId: string; isInitial: boolean; pageNumber: number; totalPages: number }) => void): () => void;
}
export interface ApplyNewDocumentInput {
  bytes: ArrayBuffer;
  name: string;
  targetPage: number;
  manager: DocumentManagerCapability;
  scroll: ScrollCapabilityLike;
  previous?: { documentId: string; page: number };
}
export function applyNewDocument(input: ApplyNewDocumentInput): Promise<{ documentId: string }>;
export function postToHost(message: WebviewToHost): void;
export function onHostMessage(handler: (message: HostToWebview) => void): () => void;
```

- [ ] **Step 1: 写失败的测试**

```ts
test('成功后先跳页再关旧文档', async () => { /* 断言调用顺序：open → scrollToPage → close，且 scrollToPage 参数 pageNumber 等于 targetPage */ });
test('目标页超出页数时跳到末页', async () => { /* targetPage 9，layoutReady.totalPages 3 → scrollToPage({pageNumber: 3}) */ });
test('打开失败抛错且不关闭旧文档', async () => { /* open 的 wait reject → rejects，close 未调用 */ });
test('零页文档视为失败', async () => { /* layoutReady.totalPages 0 → 抛错，close(newId) 被调用 */ });
test('没有旧文档时不调用 close', async () => { /* previous 省略 → close 0 次 */ });
```

假的 `manager.openDocumentBuffer` 返回 `{ wait: async () => undefined }`，`scroll` 在 open 后立刻用新 documentId 调 `onLayoutReady`，并记录 `forDocument` 收到的 id。

- [ ] **Step 2: 运行，确认失败**

Run: `pnpm exec vitest run tests/loadDocument.test.ts`
Expected: FAIL，模块不存在。

- [ ] **Step 3: 写最小代码**

`applyNewDocument` 先订阅 `onLayoutReady`（筛 `documentId` 与新 id、`isInitial`），再 `openDocumentBuffer({ buffer: bytes, name, autoActivate: true })` 并 `await .wait()`。拿到新 id 后等一次 `layoutReady`；`totalPages` 为 0 时关新文档并抛错。`pageNumber = Math.min(targetPage, totalPages)`，跳页完成后关旧文档，最后退订。失败路径关掉已创建的新文档，旧文档保持激活。

`App.tsx`：`onReady(registry)` 里取两个能力并缓存；收到 `document` 时调 `applyNewDocument`，把当前文档信息存在 ref 里；`page` 变化用 `scroll.onPageChange` 回传 `{type:'page'}`；渲染失败回传 `{type:'error',kind:'render'}` 并保留旧内容；`document` 早于 `onReady` 到达时只存最新一条，就绪后补做。

收到 `error` 消息时在预览上方显示错误条。读不到显示“无法读取文件”，渲染失败显示“PDF 无法渲染”。条内放“重试”按钮，点击发 `{type:'retry'}`。

- [ ] **Step 4: 运行，确认通过**

Run: `pnpm exec vitest run tests/loadDocument.test.ts && pnpm run build`
Expected: PASS，构建退出码 0。

- [ ] **Step 5: 提交**

```bash
git add -A && git commit -m "feat: webview 换文档、回页与回滚"
```

### Task 7: 默认关联、命令与激活

**Files:**
- Create: `src/extension/association.ts`、`tests/association.test.ts`
- Modify: `src/extension/extension.ts`、`src/extension/pdfEditorProvider.ts`
- Test: `tests/association.test.ts`

**Interfaces:**
- Consumes: `PageState`（Task 2）、`PdfPreviewProvider`（Task 5）、`Theme`（Task 2）
- Produces:

```ts
export const ASSOCIATION_KEY = 'workbench.editorAssociations';
export const SET_DEFAULT_COMMAND = 'embedpdf.setAsDefault';
export const RELOAD_COMMAND = 'embedpdf.reload';
export function associationEntry(): Record<string, string>;   // {'*.pdf': 'embedpdf.preview'}
export function isAssociatedToUs(read: () => Record<string, unknown>): boolean;
export function setAsDefault(deps: {
  read: () => Record<string, unknown>;
  update(value: Record<string, string>): Promise<void>;
  confirm(): Promise<boolean>;
}): Promise<boolean>;
export function notifyMissingAssociationOnce(deps: {
  read: () => Record<string, unknown>;
  notified(): boolean;
  markNotified(): Promise<void>;
  notify(): Promise<void>;
}): Promise<void>;
```

- [ ] **Step 1: 写失败的测试**

```ts
test('合并写入，保留其他扩展名', async () => { /* read 返回 {'*.foo':'x'} → update 收到 {'*.foo':'x','*.pdf':'embedpdf.preview'} */ });
test('用户取消则不写入', async () => { /* confirm false → update 未调用，返回 false */ });
test('已关联时不重复通知', async () => { /* read 返回 {'*.pdf':'embedpdf.preview'} → notify 0 次 */ });
test('未关联时只通知一次', async () => { /* 第一次 notify 1 次并 markNotified；notified() 变 true 后不再通知 */ });
```

- [ ] **Step 2: 运行，确认失败**

Run: `pnpm exec vitest run tests/association.test.ts`
Expected: FAIL。

- [ ] **Step 3: 写最小代码并接线**

`association.ts` 按测试实现；`update` 用 `vscode.workspace.getConfiguration().update(ASSOCIATION_KEY, value, vscode.ConfigurationTarget.Global)` 包装；`confirm` 用 `showInformationMessage('设为默认？', { modal: true }, '设为默认')`。

`extension.ts`：注册 `PdfPreviewProvider`，注册方式用 `vscode.window.registerCustomEditorProvider(PdfPreviewProvider.viewType, provider, { webviewOptions: { retainContextWhenHidden: true }, supportsMultipleEditorsPerDocument: false })`；注册两条命令，`embedpdf.reload` 对当前活动预览调 `reloadNow()`（无活动预览时 `showInformationMessage('没有打开的 PDF 预览')`）；`embedpdf.setAsDefault` 走 `setAsDefault`；激活时调 `notifyMissingAssociationOnce`，`globalState` 键 `embedpdf.associationNotified`；监听 `onDidChangeActiveColorTheme` 转发 `setTheme`。

- [ ] **Step 4: 运行，确认通过**

Run: `pnpm exec vitest run && pnpm exec tsc --noEmit && pnpm run build`
Expected: 全部 PASS，类型检查与构建退出码 0。

- [ ] **Step 5: 提交**

```bash
git add -A && git commit -m "feat: 默认关联命令、重载命令与激活接线"
```

### Task 8: 打包、文档与手工验收

**Files:**
- Create: `README.md`
- Modify: `package.json`
- Test: 手工清单

**Interfaces:**
- Consumes: 全部
- Produces: `dist/` 可运行的扩展；`.vsix` 安装包；README 使用说明。

- [ ] **Step 1: 构建并检查产物**

Run: `pnpm run build && ls -lh dist/media/pdfium.wasm dist/media/fonts | head`
Expected: wasm 约 4.6 MB，字体目录含 `NotoSansHans-Regular.otf`、`NotoSansHans-Bold.otf`、4 个 `NotoSans-*.ttf`。

- [ ] **Step 2: 打包**

Run: `pnpm exec vsce package --no-dependencies -o dist/embedpdf-preview.vsix`
Expected: 生成 `.vsix`，输出中无 “WARNING Missing repository field” 以外的报错。

- [ ] **Step 3: 手工清单（F5 启动扩展宿主）**

用 20 页内、5 MB 内的 PDF，逐条勾：

- [ ] 双击 `.pdf` 进入预览（先执行“设为默认”）。
- [ ] 翻到第 5 页，外部改写文件，1 秒内重载并停在第 5 页。
- [ ] 关闭编辑器再打开，回到第 5 页。
- [ ] 重启 VS Code，编辑器恢复且停在第 5 页。
- [ ] 断网，含中文的 PDF 不缺字。
- [ ] 删除文件，1.5 秒后出现提示；恢复文件后继续重载。
- [ ] 打开截断的 PDF，显示错误、保留旧内容、不崩溃。
- [ ] 用 `mv` 替换 PDF，只重载一次、无删除提示。
- [ ] 同一 PDF 已打开时再双击，聚焦已有编辑器。
- [ ] 未设默认时，激活后通知只出现一次。
- [ ] 打开命令面板“开发者: 打开 Webview 开发者工具”，网络面板刷新页面，确认没有 `fonts.googleapis.com`、`fonts.gstatic.com`、`cdn.jsdelivr.net` 请求。

- [ ] **Step 4: 写 README**

内容：功能三条、安装方式（vsix）、设为默认的方法、已知限制。已知限制列四条：20 页内承诺、繁体日韩缺字、单视图、截断 PDF 只少页。中文按 STC 规则，写完运行：

`node /Users/joudermin/.agents/skills/stc/tools/cli.mjs check README.md --profile for-document --anti-echo`

- [ ] **Step 5: 提交**

```bash
git add -A && git commit -m "docs: 使用说明与手工验收记录"
```
