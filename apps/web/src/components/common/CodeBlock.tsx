import { useState, useRef, useEffect } from 'react';
import Editor from '@monaco-editor/react';
import type { editor } from 'monaco-editor';

type CodeBlockProps = {
  code: string;
  language: string;
  lineStart?: number;
  filePath?: string;
  repoUrl?: string;
};

export function CodeBlock({ code, language, lineStart, filePath, repoUrl }: CodeBlockProps) {
  const [copied, setCopied] = useState(false);
  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const handleCopy = () => {
    navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const lines = code.split('\n');

  // 构建 GitLab URL，确保 repoUrl 不以斜杠结尾
  const cleanRepoUrl = repoUrl?.replace(/\/$/, '');
  const gitlabUrl = cleanRepoUrl && filePath
    ? `${cleanRepoUrl}/tree/master/${filePath}#L${lineStart}-${(lineStart || 0) + lines.length - 1}`
    : null;

  // 计算编辑器高度（每行约 19px），最大高度 600px
  const editorHeight = Math.min(lines.length * 19 + 10, 600);

  // 处理滚动事件传递
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const handleWheel = (e: WheelEvent) => {
      const editor = editorRef.current;
      if (!editor) return;

      const scrollTop = editor.getScrollTop();
      const scrollHeight = editor.getScrollHeight();
      const clientHeight = editor.getLayoutInfo().height;

      // 如果内容高度小于等于容器高度，不需要内部滚动，直接传递给外部
      if (scrollHeight <= clientHeight) {
        return;
      }

      // 向下滚动且已经到底部
      if (e.deltaY > 0 && scrollTop + clientHeight >= scrollHeight - 1) {
        return;
      }

      // 向上滚动且已经到顶部
      if (e.deltaY < 0 && scrollTop <= 0) {
        return;
      }

      // 其他情况阻止事件传递，让编辑器内部处理滚动
      e.stopPropagation();
    };

    container.addEventListener('wheel', handleWheel, { passive: false });
    return () => container.removeEventListener('wheel', handleWheel);
  }, []);

  const handleEditorDidMount = (editor: editor.IStandaloneCodeEditor) => {
    editorRef.current = editor;
  };

  return (
    <div className="relative group" ref={containerRef}>
      <div className="absolute top-2 right-2 flex gap-2 opacity-0 group-hover:opacity-100 transition-opacity z-10">
        {gitlabUrl && (
          <a
            href={gitlabUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="px-3 py-1.5 bg-white hover:bg-gray-50 text-gray-700 rounded-lg text-xs font-medium transition-all flex items-center gap-1.5 shadow-sm border border-gray-200"
          >
            <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 24 24">
              <path d="M22.65 14.39L12 22.13 1.35 14.39a.84.84 0 0 1-.3-.94l1.22-3.78 2.44-7.51A.42.42 0 0 1 4.82 2a.43.43 0 0 1 .58 0 .42.42 0 0 1 .11.18l2.44 7.49h8.1l2.44-7.51A.42.42 0 0 1 18.6 2a.43.43 0 0 1 .58 0 .42.42 0 0 1 .11.18l2.44 7.51L23 13.45a.84.84 0 0 1-.35.94z"/>
            </svg>
            GitLab
          </a>
        )}
        <button
          onClick={handleCopy}
          className="px-3 py-1.5 bg-white hover:bg-gray-50 text-gray-700 rounded-lg text-xs font-medium transition-all flex items-center gap-1.5 shadow-sm border border-gray-200"
        >
          {copied ? (
            <>
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
              已复制
            </>
          ) : (
            <>
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
              </svg>
              复制
            </>
          )}
        </button>
      </div>
      <div className="border border-gray-200 rounded-lg overflow-hidden">
        <Editor
          height={editorHeight}
          language={language}
          value={code}
          theme="vs"
          onMount={handleEditorDidMount}
          options={{
            readOnly: true,
            minimap: { enabled: false },
            scrollBeyondLastLine: false,
            fontSize: 12,
            lineNumbers: lineStart ? (lineNumber) => String(lineStart + lineNumber - 1) : 'on',
            glyphMargin: false,
            folding: false,
            lineDecorationsWidth: 0,
            lineNumbersMinChars: 4,
            renderLineHighlight: 'none',
            scrollbar: {
              vertical: 'auto',
              horizontal: 'auto',
              verticalScrollbarSize: 10,
              horizontalScrollbarSize: 10,
            },
            overviewRulerLanes: 0,
            hideCursorInOverviewRuler: true,
            overviewRulerBorder: false,
            wordWrap: 'on',
            wrappingStrategy: 'advanced',
            padding: { top: 8, bottom: 8 },
          }}
        />
      </div>
    </div>
  );
}
