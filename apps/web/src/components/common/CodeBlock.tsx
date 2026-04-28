import { useState, useEffect } from 'react';
import Prism from 'prismjs';
import 'prismjs/themes/prism-tomorrow.css';
import 'prismjs/components/prism-typescript';
import 'prismjs/components/prism-javascript';
import 'prismjs/components/prism-jsx';
import 'prismjs/components/prism-tsx';

type CodeBlockProps = {
  code: string;
  language: string;
  lineStart?: number;
  filePath?: string;
  repoUrl?: string;
};

export function CodeBlock({ code, language, lineStart, filePath, repoUrl }: CodeBlockProps) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    Prism.highlightAll();
  }, [code]);

  const handleCopy = () => {
    navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const lines = code.split('\n');
  const gitlabUrl = repoUrl && filePath ? `${repoUrl}/-/blob/main/${filePath}#L${lineStart}-${(lineStart || 0) + lines.length - 1}` : null;

  return (
    <div className="relative group">
      <div className="absolute top-2 right-2 flex gap-2 opacity-0 group-hover:opacity-100 transition-opacity z-10">
        {gitlabUrl && (
          <a
            href={gitlabUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="px-3 py-1.5 bg-slate-700 hover:bg-slate-600 text-gray-300 rounded-lg text-xs font-medium transition-all flex items-center gap-1.5"
          >
            <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 24 24">
              <path d="M22.65 14.39L12 22.13 1.35 14.39a.84.84 0 0 1-.3-.94l1.22-3.78 2.44-7.51A.42.42 0 0 1 4.82 2a.43.43 0 0 1 .58 0 .42.42 0 0 1 .11.18l2.44 7.49h8.1l2.44-7.51A.42.42 0 0 1 18.6 2a.43.43 0 0 1 .58 0 .42.42 0 0 1 .11.18l2.44 7.51L23 13.45a.84.84 0 0 1-.35.94z"/>
            </svg>
            GitLab
          </a>
        )}
        <button
          onClick={handleCopy}
          className="px-3 py-1.5 bg-slate-700 hover:bg-slate-600 text-gray-300 rounded-lg text-xs font-medium transition-all flex items-center gap-1.5"
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
      <pre className="bg-slate-900 p-4 rounded-lg text-sm overflow-x-auto border border-slate-700">
        <code className={`language-${language}`}>
          {lines.map((line, i) => (
            <div key={i} className="table-row">
              {lineStart && (
                <span className="table-cell pr-4 text-right text-slate-500 select-none" style={{ minWidth: '3em' }}>
                  {lineStart + i}
                </span>
              )}
              <span className="table-cell">{line}</span>
            </div>
          ))}
        </code>
      </pre>
    </div>
  );
}
