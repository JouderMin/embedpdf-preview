import { PDFViewer } from '@embedpdf/react-pdf-viewer';
import type { EmbedPdfContainer } from '@embedpdf/react-pdf-viewer';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { HostToWebview, Theme } from '../shared/protocol';
import { onHostMessage, postToHost } from './bridge';
import {
  applyNewDocument,
  type DocumentManagerCapability,
  type ScrollCapabilityLike,
} from './loadDocument';
import { createViewerConfig } from './viewerConfig';

type DocumentMessage = Extract<HostToWebview, { type: 'document' }>;
type ViewerProps = Parameters<typeof PDFViewer>[0];
type Registry = Parameters<NonNullable<ViewerProps['onReady']>>[0];

interface DocumentManagerRuntime extends DocumentManagerCapability {
  onDocumentError?(
    handler: (event: { documentId: string; message: string }) => void,
  ): () => void;
}

interface ScrollRuntime extends ScrollCapabilityLike {
  onPageChange?(
    handler: (event: { documentId: string; pageNumber: number }) => void,
  ): () => void;
}

const WASM_URL = new URL('./media/pdfium.wasm', import.meta.url).toString();
const FONT_BASE_URL = new URL('./media/fonts/', import.meta.url).toString();

function capabilityOf<T>(registry: Registry, name: string): T | undefined {
  const provider = registry.getCapabilityProvider(name);
  if (!provider || typeof provider.provides !== 'function') {
    return undefined;
  }
  return provider.provides() as T | undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function readPage(scroll: ScrollCapabilityLike, documentId: string, fallback: number): number {
  try {
    const page = scroll.forDocument(documentId).getCurrentPage();
    return Number.isFinite(page) && page >= 1 ? Math.trunc(page) : fallback;
  } catch {
    return fallback;
  }
}

export function App() {
  const [theme, setTheme] = useState<Theme>('light');
  const [error, setError] = useState<{ kind: 'read' | 'render'; message: string } | null>(null);

  const containerRef = useRef<EmbedPdfContainer | null>(null);
  const managerRef = useRef<DocumentManagerRuntime | undefined>(undefined);
  const scrollRef = useRef<ScrollRuntime | undefined>(undefined);
  const currentRef = useRef<{ documentId: string; page: number } | undefined>(undefined);
  const pendingRef = useRef<DocumentMessage | undefined>(undefined);
  const processingRef = useRef(false);
  const nameRef = useRef('document.pdf');
  const cleanupsRef = useRef<Array<() => void>>([]);
  const processRef = useRef<() => Promise<void>>(async () => undefined);

  const reportRender = (message: string) => {
    setError({ kind: 'render', message });
    postToHost({ type: 'error', kind: 'render', message });
  };

  const processPending = async (): Promise<void> => {
    if (processingRef.current) {
      return;
    }
    processingRef.current = true;
    try {
      while (pendingRef.current) {
        const manager = managerRef.current;
        const scroll = scrollRef.current;
        if (!manager || !scroll) {
          return;
        }
        const message = pendingRef.current;
        pendingRef.current = undefined;

        const current = currentRef.current;
        const previous = current
          ? { documentId: current.documentId, page: readPage(scroll, current.documentId, current.page) }
          : undefined;

        try {
          const result = await applyNewDocument({
            bytes: message.bytes,
            name: nameRef.current,
            targetPage: message.page,
            manager,
            scroll,
            previous,
          });
          currentRef.current = { documentId: result.documentId, page: message.page };
          setError(null);
        } catch (loadError) {
          reportRender(errorMessage(loadError));
        }
      }
    } finally {
      processingRef.current = false;
    }
  };
  processRef.current = processPending;

  const handleRegistryReady = (registry: Registry) => {
    managerRef.current = capabilityOf<DocumentManagerRuntime>(registry, 'document-manager');
    scrollRef.current = capabilityOf<ScrollRuntime>(registry, 'scroll');

    if (!managerRef.current || !scrollRef.current) {
      reportRender('PDF 查看器未就绪');
      return;
    }

    for (const cleanup of cleanupsRef.current) {
      cleanup();
    }
    cleanupsRef.current = [];

    const pageSubscription = scrollRef.current.onPageChange?.((event) => {
      const current = currentRef.current;
      if (current && event.documentId === current.documentId) {
        current.page = event.pageNumber;
        postToHost({ type: 'page', page: event.pageNumber });
      }
    });
    if (pageSubscription) {
      cleanupsRef.current.push(pageSubscription);
    }

    const errorSubscription = managerRef.current.onDocumentError?.((event) => {
      if (currentRef.current?.documentId === event.documentId) {
        reportRender(event.message || 'PDF 无法渲染');
      }
    });
    if (errorSubscription) {
      cleanupsRef.current.push(errorSubscription);
    }

    void processRef.current();
  };

  useEffect(() => {
    const unsubscribe = onHostMessage((message) => {
      switch (message.type) {
        case 'init':
          nameRef.current = message.name;
          setTheme(message.theme);
          break;
        case 'document':
          pendingRef.current = message;
          void processRef.current();
          break;
        case 'theme':
          setTheme(message.theme);
          break;
        case 'error':
          setError({ kind: message.kind, message: message.message });
          break;
        default:
          break;
      }
    });
    postToHost({ type: 'ready' });

    return () => {
      unsubscribe();
      for (const cleanup of cleanupsRef.current) {
        cleanup();
      }
      cleanupsRef.current = [];
    };
  }, []);

  useEffect(() => {
    // PDFViewer 的 effect 依赖为空，后续 config.theme 不会重建 viewer；
    // 主题切换必须走自定义元素的 setTheme。
    containerRef.current?.setTheme(theme);
  }, [theme]);

  const config = useMemo(
    () =>
      createViewerConfig({
        theme,
        wasmUrl: WASM_URL,
        fontBaseUrl: FONT_BASE_URL,
      }),
    [theme],
  );

  return (
    <div className="embedpdf-root">
      <PDFViewer
        config={config}
        onInit={(container) => {
          containerRef.current = container;
          container.setTheme(theme);
        }}
        onReady={handleRegistryReady}
      />
      {error ? (
        <div className="embedpdf-error" role="alert" title={error.message}>
          <span>{error.kind === 'read' ? '无法读取文件' : 'PDF 无法渲染'}</span>
          <button type="button" onClick={() => postToHost({ type: 'retry' })}>
            重试
          </button>
        </div>
      ) : null}
    </div>
  );
}
