# EmbedPDF VS Code 预览扩展设计

2026-11-02

## 1 目标与原因

目标是给 VS Code 增加 PDF 预览。打开 `.pdf` 文件时用 EmbedPDF 渲染；文件在磁盘上变化后自动重载，并回到重载前的页面。

原因：写文档时 PDF 由 TeX 或其他工具反复生成，读者要在编辑器和预览之间来回切换。每次重载都回到第 1 页，读者需要手动翻回原页，查看长文档时这一步很费时。

成功的标准有三条：

1. 双击 `.pdf` 直接进入预览，不经过其他扩展。
2. 文件保存后 1 秒内重载完成，页面停在重载前的那一页。验收用 20 页以内、5 MB 以内的 PDF；从保存事件算到跳页完成。
3. 预览过程不发任何网络请求，断网可用。

## 2 非目标与反目标

非目标，第一版不做：

- 批注、表单、签名等写入类功能保存回文件。
- 打印、下载、导出。
- 多文档标签页。
- 远程文件系统与虚拟工作区。
- 加密 PDF 的密码输入界面。

反目标，出现即视为失败：

- 重载后页码丢失或跳到第 1 页。
- 依赖 CDN 或任何外部网络资源。
- 文件损坏、被删除或读取失败时扩展崩溃或弹错误栈。
- 批注看起来可编辑，但保存不了。

## 3 约束

- 全功能界面，采用 EmbedPDF 自带界面，不自建工具栏。
- 字体本地打包，不请求 jsDelivr。
- 扩展运行在 VS Code webview 中，webview 默认没有网络访问，CSP 需要显式放开 WASM 与字体。
- 工作区路径含中文（`/Volumes/外置SSD/...`），路径处理不得假设 ASCII。
- VS Code 版本 1.85 及以上，Node.js 20。
- 验收文档 20 页以内、5 MB 以内。超过这个规模不保证 1 秒。
- 打包体积约 26 MB：PDFium WASM 4.6 MB，字体 18 MB，界面代码约 3 MB。

## 4 方案

考虑了三种做法。

| 方案 | 内容 | 取舍 |
|---|---|---|
| A | React 加 `@embedpdf/react-pdf-viewer`，Vite 打包成 webview | 界面现成，`onReady` 给出 registry，可用官方能力记录页码、换文档、跳页。多一层 React 与构建链 |
| B | `@embedpdf/snippet` 原生 `init`，不引 React | 依赖最少，界面与 A 相同。换文档只能重设 config 整体重绘，没有换文档 API |
| C | headless 组件自己拼全功能界面 | 控制力最强，但要重做工具栏、搜索、缩略图、批注侧栏，工作量是 A 的数倍 |

选择 A。理由是需求要全功能界面，A 直接得到该界面，同时保留官方 API 做重载与回页。B 的换文档路径不公开，C 的工作量与需求不匹配。

## 5 设计

### 5.1 组件划分

```
src/extension/          扩展端，Node.js 环境
  extension.ts          activate：注册编辑器、命令、主题监听
  pdfEditorProvider.ts  CustomReadonlyEditorProvider，管理每个编辑器的生命周期
  reloadController.ts   文件监听、去抖、重载编排
  pageState.ts          按文件 URI 读写页码
  association.ts        “设为默认”命令与首次打开通知
  webviewHtml.ts        生成 HTML、CSP、资源 URI、nonce
src/webview/            webview 端，浏览器环境
  main.tsx              React 入口
  App.tsx               挂载 PDFViewer，处理初始化与重载消息
  viewerConfig.ts       生成 PDFViewerConfig：主题、字体、禁用分类
  bridge.ts             消息收发与类型守卫
src/shared/protocol.ts  两端共用的消息类型
```

扩展端用 esbuild 打包成 CommonJS，webview 端用 Vite 打包成 ES 模块。资源在构建时复制：`node_modules/@embedpdf/pdfium/dist/pdfium.wasm` 与 `@embedpdf/fonts-sc`、`@embedpdf/fonts-latin` 的字体文件复制到 `media/`。

单视图策略：注册编辑器时设 `supportsMultipleEditorsPerDocument: false`。同一 PDF 已经打开时，再次双击只会聚焦已有编辑器，不再新建。理由：重载状态与页码都在编辑器实例内，两个视图同时重载会争用同一页码键；按文档单例广播则要改 provider 与 reloadController 的所有权模型，第一版不值得。

### 5.2 消息协议

扩展端到 webview：

| 类型 | 字段 | 用途 |
|---|---|---|
| `init` | `uri`, `name`, `page`, `theme` | 首次加载，带页码与主题 |
| `document` | `bytes: ArrayBuffer`, `page`, `revision` | 重载，带新字节 |
| `theme` | `theme: 'light' \| 'dark'` | VS Code 主题变化 |
| `error` | `message` | 读取或解析失败 |

webview 到扩展端：

| 类型 | 字段 | 用途 |
|---|---|---|
| `ready` | 无 | webview 挂载完成 |
| `page` | `page: number` | 当前页变化，扩展端持久化 |
| `error` | `message` | 渲染失败 |

字节通过 `postMessage` 的 structured clone 传递，不转 base64。读取时用 `vscode.workspace.fs.readFile`，返回的 `Uint8Array` 取其 `buffer`，`byteOffset` 不为 0 时先复制。

首屏与重载共用一条加载路径：webview 发出 `ready` 后，扩展端读取文件并发 `document`。不使用 `asWebviewUri` 让 webview 直接取文件，因为那需要把 `localResourceRoots` 放开到工作区目录，并且与重载路径形成两套加载代码。

### 5.3 重载与回页流程

重载在 webview 内完成，不重建 webview，也不重新初始化 PDFium。

1. webview 收到 `document` 消息。
2. 从 `registry.getCapabilityProvider('document-manager').provides()` 取文档管理能力，从 `getCapabilityProvider('scroll').provides()` 取滚动能力。
3. 用 `scroll.forDocument(当前文档 ID).getCurrentPage()` 记录旧页 `P`。消息里的 `page` 作为兜底。
4. 先订阅 `scroll.onLayoutReady`，筛出 `documentId` 等于新文档且 `isInitial` 为真的第一次事件。
5. 调用 `documentManager.openDocumentBuffer({ buffer, name, autoActivate: true })`，等 task 完成，得到新文档 ID。
6. 在新文档布局就绪后调用 `scroll.forDocument(新文档 ID).scrollToPage({ pageNumber: P, behavior: 'instant' })`。
7. 跳页完成后调用 `documentManager.closeDocument(旧文档 ID)`，释放旧文档内存。

说明：先开新文档再关旧文档，避免预览区出现空白闪烁。旧文档关闭失败只记录日志，不影响新文档。

重载分两步提交与回滚：

1. 提交：新文档打开成功、至少 1 页、布局就绪后第一次渲染没有报错，才算成功。成功后才关闭旧文档。
2. 回滚：`openDocumentBuffer` 报错、页数为 0，或首次渲染报错时，关闭新文档并重新激活旧文档，跳到重载前的页。页数少于预期不算失败，截断的 PDF 常常不报错、只少页，第一版按已知限制处理（见第 8 节）。
3. 错误分两类：读不到文件与渲染失败。两类文字不同，重试按钮相同。读不到指读取失败或文件不存在；渲染失败指解析或渲染报错。

### 5.4 字体与 WASM

WASM：`wasmUrl` 指向 `media/pdfium.wasm` 的 webview URI。`worker` 设为 `false`，因为 worker 在 webview 中的 CSP 与资源协议尚未验证，主线程 PDFium 更稳（见第 8 节）。

字体：`fontFallback` 的 `baseUrl` 指向 `media/fonts/` 的 webview URI，条目如下。

| 字符集 | 字体 | 字重 |
|---|---|---|
| `GB2312` | NotoSansHans-Regular.otf | 400 |
| `GB2312` | NotoSansHans-Bold.otf | 700 |
| `CYRILLIC`、`GREEK`、`VIETNAMESE` | NotoSans-Regular.ttf、Italic、Bold、BoldItalic | 400、700 |

说明：`fontFallback` 只在 PDF 缺少嵌入字体时使用。繁体中文、日文、韩文第一版不带，遇到时会显示缺字，后续按需增加字体包。

### 5.5 界面与分类

采用自带界面，关闭与预览定位冲突的分类：写入类（`annotation`、`form`、`redaction`、`signature`、`stamp`）与文件类（`print`、`export`、`attachment`、`fullscreen`，以及打开文件、下载两项命令）。

保留阅读类：搜索、缩放、缩略图、书签、选中复制、旋转、滚动布局、页码跳转。

理由：文档以只读方式打开，批注改动无法保存。显示可编辑的批注会误导读者，以为改动已写入文件。

`tabBar` 设为 `never`，单文档不需要标签页。

### 5.6 主题

主题取自 `vscode.window.activeColorTheme.kind`。`Dark` 与 `HighContrast` 映射为 `dark`，其余映射为 `light`。监听 `onDidChangeActiveColorTheme`，变化时发 `theme` 消息。

说明：不使用 `theme.preference: 'system'`，因为 VS Code 主题与操作系统外观无关。

### 5.7 文件监听

每个编辑器用 `vscode.workspace.createFileSystemWatcher` 监听所在目录，正则过滤自身文件名。`onDidChange` 触发后去抖 300 毫秒再读取。去抖避免保存时多次写入造成重复重载。

补充行为：

- `onDidDelete` 不立即提示。等待 1.5 秒后文件仍未出现，才发 `error` 消息；文件在此期间重新出现则视为改名替换，直接重载。
- 读到写了一半的文件时，解析多半失败。失败后重试读取，最多 3 次，间隔 200 毫秒；仍失败则按“渲染失败”提示，旧内容保留。
- 监听器在编辑器 `dispose` 时释放。
- 手动重载命令 `embedpdf.reload` 跳过监听直接读取并发送。

说明：TeX 引擎编译时直接写目标 PDF，文件会在几百毫秒内被反复改写。系统文件监听会产生多次 `change`，改名替换还会产生 `delete` 加 `create`。去抖、删除宽限期与解析重试三者合起来，才能避免编译过程中报错或闪烁。

### 5.8 页码持久化

页码存在 `context.globalState`，键为 `embedpdf.page.<文件 URI>`。webview 每次发 `page` 时写入，节流 500 毫秒。编辑器打开时读该键，作为 `init` 消息的 `page`。

说明：按 URI 而不是文件名保存，同名文件在不同目录互不影响。VS Code 重启后自定义编辑器会自动恢复，页码从 `globalState` 取回。

### 5.9 错误处理

| 情况 | 表现 |
|---|---|
| 文件读取失败 | webview 显示“无法读取文件”与“重试”按钮 |
| PDF 解析失败 | webview 显示“PDF 无法渲染”与“重试”按钮，页面保留上一次成功的内容 |
| 文件被删除，1.5 秒宽限后仍不存在 | 顶部提示“文件已删除”，预览保留 |
| 字体或 WASM 加载失败 | 控制台记录，预览显示错误码 |

不使用 `showErrorMessage` 弹窗，避免每次保存都打扰读者。

### 5.10 构建与打包

npm 脚本：

- `build`：esbuild 打包扩展端，Vite 打包 webview，复制资源。
- `watch`：同上，两个构建器都监听。
- `test`：vitest 跑单元测试。
- `package`：`@vscode/vsce package` 生成 vsix。

Vite 输出固定文件名（`webview.js`、`webview.css`），因为扩展端的 HTML 需要在运行时拼资源 URI，无法读哈希文件名。

### 5.11 默认关联

多个扩展声明 `.pdf` 时，VS Code 首次打开让用户选择并记住。本扩展加两条入口：

- 命令 `embedpdf.setAsDefault`：把 `workbench.editorAssociations` 的 `*.pdf` 写到用户设置，值为 `embedpdf.preview`。写入前弹确认框，说明这会改变其他 PDF 扩展的打开行为。
- 扩展激活时检查：扩展以 `onStartupFinished` 启动，读取 `workbench.editorAssociations` 里 `*.pdf` 的值，不是本扩展时发一次通知“PDF 预览已安装，设为默认？”。通知用 `globalState` 记已读，只出现一次。

说明：通知不能在“首次打开 PDF”时触发，因为未设默认时本扩展根本不会打开 PDF。所以放在扩展激活时。

不静默修改用户设置。用户拒绝后，仍可按命令提示，或自行在设置里改。

说明：VS Code 没有“注册即默认”的机制，多扩展竞争时只能靠关联设置或用户首次选择。写入用户设置需要用户确认，因此放在命令里。

## 6 验证

单元测试覆盖纯逻辑：

1. `pageState`：写入、读取、节流、URI 含中文。
2. `reloadController`：去抖合并多次事件、编辑器关闭后不再触发。
3. `reloadController` 状态机：删除后 1.5 秒内重建不提示；半写文件解析失败后重试 3 次；3 次仍失败时发错误并保留旧内容。
4. `viewerConfig`：主题映射、字体条目、禁用分类列表。
5. `webviewHtml`：CSP 含 `wasm-unsafe-eval`，nonce 每次不同。
6. 重载提交条件：页数为 0 时回滚，不关闭旧文档。

手工验证清单：

1. 打开 PDF，翻到第 5 页，在外部修改文件，确认 1 秒内重载且停在第 5 页。
2. 关闭编辑器再打开，确认回到第 5 页。
3. 重启 VS Code，确认编辑器恢复且停在第 5 页。
4. 断网后打开含中文的 PDF，确认不缺字。
5. 删除文件，确认 1.5 秒后出现提示，恢复文件后继续重载。
6. 打开截断的 PDF，确认显示错误，不崩溃。
7. 用临时文件加改名的工具替换 PDF，确认只重载一次、不出现删除提示。
8. 同一 PDF 已在预览中时再双击，确认聚焦已有编辑器，不新建第二个视图。
9. 执行“设为默认”命令，确认 `workbench.editorAssociations` 写入，双击 `.pdf` 直接进预览。
10. 扩展激活时未设默认，确认通知只出现一次。

## 7 可自行决定的事项

可以自行决定：

- 目录与文件命名细节。
- esbuild 与 Vite 的具体配置。
- 错误提示的样式。
- 日志格式。

需要先核实再写死（第 8 节）：分类名精确值、`openDocumentBuffer` 热切换时序、字体加载路径、worker 可行性。

## 8 已知风险

1. `openDocumentBuffer` 后 `onLayoutReady` 的触发时机与文档激活顺序，可能需要在跳页前等待渲染插件就绪。若时序不稳，退到“重设 config 让整个 viewer 重建”，代价是丢缩放与界面状态。
2. worker 模式下 WASM 与字体在 worker 内加载，CSP 与 `vscode-webview-resource` 协议可能不支持。第一版关闭 worker。
3. 自带界面的分类名是字符串。文档只给了少量示例，包内清单已提取到 `document-*`、`annotation*`、`redaction*` 等名称，精确集合需核实。
4. `retainContextWhenHidden` 让后台标签页保留 DOM，内存占用随打开的 PDF 数量增长。第一版开启，因为页码与缩放不丢的收益更大。
5. 默认关联存在竞争。本机已装 `mathematic.vscode-pdf`、`latex-pdf-preview`、`lilypond-pdf-preview`，`latex-workshop` 另有外置查看器。多个扩展都声明 `.pdf` 时，VS Code 首次打开会让用户选择并记住。已定用命令加一次性通知引导，用户拒绝或以后再装扩展时，关联可能被改回。
6. 单视图策略会让读者以为新编辑器组里没打开成功。需要在聚焦已有编辑器时给出提示。
7. 性能只对 20 页内、5 MB 内的文档承诺。更大文档仍能工作，但不保证 1 秒。全量读盘、structured clone 整份字节、整份重解析都在主线程完成。实测若超时，需加预读或分级策略，或回到 worker 方案。

## 9 已定事项

请复核以下各项：

1. 只读预览，关闭所有写入类功能。
2. 恢复到页，不恢复页内像素偏移。
3. 页码按文件 URI 存 `globalState`，跨重启保留。
4. 第一版关闭 worker，主线程运行 PDFium。
5. 字体只带简体常规与粗体、Latin 四款，不带繁体与日韩。
6. 界面用 React 加 `@embedpdf/react-pdf-viewer`。
7. 首屏与重载都走字节消息，不用 `asWebviewUri`。
8. 重载两阶段提交，失败回滚到旧文档与旧页。
9. 每个 URI 只允许一个预览视图。
10. 去抖 300 毫秒，删除宽限 1.5 秒，解析失败重试 3 次。
11. 验收规模：20 页以内、5 MB 以内；1 秒从保存事件算到跳页完成。
12. 默认关联靠命令与一次性通知引导，不静默改用户设置。
