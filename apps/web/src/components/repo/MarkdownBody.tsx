import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import Prism from 'prismjs';
import 'prismjs/themes/prism-tomorrow.css';
// 导入常用语言支持
import 'prismjs/components/prism-typescript';
import 'prismjs/components/prism-javascript';
import 'prismjs/components/prism-jsx';
import 'prismjs/components/prism-tsx';
import 'prismjs/components/prism-python';
import 'prismjs/components/prism-java';
import 'prismjs/components/prism-go';
import 'prismjs/components/prism-rust';
import 'prismjs/components/prism-sql';
import 'prismjs/components/prism-bash';
import 'prismjs/components/prism-json';
import 'prismjs/components/prism-yaml';

/**
 * Markdown 正文渲染（从 RepoPage 抽出）：问答与根因分析共用，避免两处样式漂移。
 * Prism 及全部语言包也搬到这里 —— 只有渲染回答的页面才会为它们付费。
 */
export function MarkdownBody({ children }: { children: string }) {
  return (
    <div className="prose prose-sm max-w-none">
      <div className="text-slate-700 leading-relaxed">
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          components={{
            p: ({ node, ...props }) => <p className="mb-3 text-sm" {...props} />,
            h1: ({ node, ...props }) => <h1 className="text-lg font-bold mb-3 mt-4" {...props} />,
            h2: ({ node, ...props }) => <h2 className="text-base font-bold mb-2 mt-3" {...props} />,
            h3: ({ node, ...props }) => <h3 className="text-sm font-bold mb-2 mt-3" {...props} />,
            ul: ({ node, ...props }) => <ul className="list-disc list-inside mb-3 text-sm space-y-1" {...props} />,
            ol: ({ node, ...props }) => <ol className="list-decimal mb-3 text-sm space-y-1 pl-5" {...props} />,
            li: ({ node, ...props }) => <li className="text-sm" {...props} />,
            code: ({ node, className, children, ...props }) => {
              const isInline = !className;

              if (isInline) {
                // 行内代码用靛蓝而不是红色：回答里代码标识符密度极高（一段话十几个），
                // 红色是「告警色」，整篇飘红会让用户以为处处是错误；
                // 靛蓝保持「这是代码」的辨识度，又不与错误/警告语义抢注意力。
                return <code className="bg-slate-100 px-1.5 py-0.5 rounded text-xs font-mono text-indigo-700" {...props}>{children}</code>;
              }

              // 代码块：使用 Prism 高亮
              const match = /language-(\w+)/.exec(className || '');
              const language = match ? match[1] : 'typescript';
              const code = String(children).replace(/\n$/, '');

              try {
                const grammar = Prism.languages[language];
                if (grammar) {
                  const highlighted = Prism.highlight(code, grammar, language);
                  return (
                    <code
                      className={`language-${language}`}
                      dangerouslySetInnerHTML={{ __html: highlighted }}
                      {...props}
                    />
                  );
                }
              } catch (e) {
                console.error('Prism highlight error:', e);
              }

              // 降级：无高亮
              return <code className="block text-xs font-mono" {...props}>{children}</code>;
            },
            pre: ({ node, children, ...props }) => (
              <pre className="bg-slate-900 p-4 rounded-lg mb-3 overflow-x-auto" {...props}>
                {children}
              </pre>
            ),
            blockquote: ({ node, ...props }) => <blockquote className="border-l-4 border-slate-300 pl-4 italic text-sm text-slate-600 mb-3" {...props} />,
            a: ({ node, ...props }) => <a className="text-blue-600 hover:underline text-sm" {...props} />,
            strong: ({ node, ...props }) => <strong className="font-semibold" {...props} />,
            em: ({ node, ...props }) => <em className="italic" {...props} />,
          }}
        >
          {children}
        </ReactMarkdown>
      </div>
    </div>
  );
}
