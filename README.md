# EmbedPDF PDF Preview

在 VS Code 内预览 PDF。文件变化后自动重载，并回到原页。

## 功能

- 在 VS Code 内打开 PDF，不用外部查看器。
- 监听文件变化。文件保存后自动重载，并停在当前页。
- 记住每个文件的页码。关闭编辑器或重启 VS Code 后，重新打开仍回到原页。

## 构建

构建需要 Node.js 22.12 或以上。

1. 运行 `pnpm install`。
2. 运行 `pnpm run build`。
3. 运行 `pnpm run package`。

生成的安装包位于 `dist/embedpdf-preview.vsix`。

## 安装

1. 下载 `dist/embedpdf-preview.vsix`。
2. 打开 VS Code。
3. 按 `Ctrl+Shift+P` 打开命令面板。macOS 按 `Cmd+Shift+P`。
4. 运行“Extensions: Install from VSIX...”。
5. 选择 `embedpdf-preview.vsix`。

## 设为默认

1. 打开命令面板。
2. 运行“EmbedPDF: 将 PDF 预览设为默认”。
3. 在确认框中选择“设为默认”。

说明：VS Code 允许安装多个 PDF 扩展。设置默认后，双击 `.pdf` 文件直接进入本扩展。工作区设置优先于用户设置。工作区已固定 PDF 关联时，命令会提示覆盖。

## 已知限制

- 只对 20 页以内、5 MB 以内的 PDF 承诺 1 秒内完成重载。文件更大时仍可打开，但不保证速度。
- 安装包只带 6 款字体：简体中文常规、粗体，拉丁常规、斜体、粗体、粗斜体。繁体中文、日文、韩文可能缺字。
- 同一文件只打开一个预览。再次双击时，VS Code 聚焦已有编辑器。
- 截断的 PDF 显示的页数可能少于原文件。出现错误时，预览保留旧内容。
