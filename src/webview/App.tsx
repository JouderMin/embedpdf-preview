import { PDFViewer } from '@embedpdf/react-pdf-viewer';
import type { EmbedPdfContainer } from '@embedpdf/react-pdf-viewer';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { HostToWebview, Theme } from '../shared/protocol';
import { onHostMessage, postToHost } from './bridge';
import {
  applyNewDocument,
  captureViewState,
  type DocumentManagerCapability,
  type ScrollCapabilityLike,
  type ZoomCapabilityLike,
} from './loadDocument';
import { prepareViewerAssets, releaseViewerAssets, type ViewerAssets } from './viewerAssets';
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

export function App() {
  const [theme, setTheme] = useState<Theme>('light');
  const [error, setError] = useState<{ kind: 'read' | 'render'; message: string } | null>(null);
  const [assets, setAssets] = useState<ViewerAssets | null>(null);
  const [assetAttempt, setAssetAttempt] = useState(0);

  const containerRef = useRef<EmbedPdfContainer | null>(null);
  const managerRef = useRef<DocumentManagerRuntime | undefined>(undefined);
  const scrollRef = useRef<ScrollRuntime | undefined>(undefined);
  const zoomRef = useRef<ZoomCapabilityLike | undefined>(undefined);
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
          ? {
              documentId: current.documentId,
              ...captureViewState(scroll, zoomRef.current, current.documentId, current.page),
            }
          : undefined;

        try {
          const result = await applyNewDocument({
            bytes: message.bytes,
            name: nameRef.current,
            targetPage: previous?.page ?? message.page,
            manager,
            scroll,
            zoom: zoomRef.current,
            previous,
          });
          currentRef.current = { documentId: result.documentId, page: result.page };
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
    zoomRef.current = capabilityOf<ZoomCapabilityLike>(registry, 'zoom');

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

  // 主线程预取 wasm 与字体，换成 blob URL 后再交给 worker 引擎。
  // worker 内直接 fetch webview 资源会卡在 service worker 超时（见 viewerAssets.ts）。
  useEffect(() => {
    const controller = new AbortController();
    let loaded: ViewerAssets | null = null;
    prepareViewerAssets(controller.signal)
      .then((value) => {
        loaded = value;
        setAssets(value);
      })
      .catch((loadError: unknown) => {
        if (controller.signal.aborted) {
          return;
        }
        const message = errorMessage(loadError);
        setError({ kind: 'render', message });
        postToHost({ type: 'error', kind: 'render', message });
      });
    return () => {
      controller.abort();
      if (loaded) {
        releaseViewerAssets(loaded);
      }
    };
  }, [assetAttempt]);

  useEffect(() => {
    // PDFViewer 的 effect 依赖为空，后续 config.theme 不会重建 viewer；
    // 主题切换必须走自定义元素的 setTheme。
    containerRef.current?.setTheme(theme);
  }, [theme]);

  const config = useMemo(
    () =>
      assets
        ? createViewerConfig({
            theme,
            wasmUrl: assets.wasmUrl,
            fontBaseUrl: '',
            fontUrls: assets.fontUrls,
          })
        : null,
    [theme, assets],
  );

  return (
    <div className="embedpdf-root">
      {config ? (
        <PDFViewer
          config={config}
          style={{ width: '100%', height: '100%' }}
          onInit={(container) => {
            containerRef.current = container;
            container.setTheme(theme);
          }}
          onReady={handleRegistryReady}
        />
      ) : null}
      {error ? (
        <div className="embedpdf-error" role="alert">
          <span>{error.kind === 'read' ? '无法读取文件' : 'PDF 无法渲染'}</span>
          <button
            type="button"
            onClick={() => {
              if (!assets) {
                setAssetAttempt((value) => value + 1);
              }
              postToHost({ type: 'retry' });
            }}
          >
            重试
          </button>
        </div>
      ) : null}
    </div>
  );
}
