import { QAResponse } from '../../types';
import { Card, CardHeader } from './Card';
import { MarkdownBody } from './MarkdownBody';
import { LoadingSpinner } from '../common/LoadingSpinner';

/**
 * 问答 / 根因分析的结果卡（从 RepoPage 抽出）。
 *
 * 边界刻意划在「渲染 + 交互回调」上：所有**业务状态**（query、loading、abort、
 * 反馈提交）都留在 RepoPage，这里只拿现成的值和回调 —— 组件内部不出现一个
 * useState，保证它是纯展示件，改交互逻辑不用动它。
 *
 * 根因分析与问答共用这张卡，差异只有三处：标题/图标/渐变色 + 一条显式声明
 * 「以下是可能原因，不是已验证的结论」。这条声明是把两种模式在视觉上分开的关键。
 */
export type AnswerCardProps = {
  result: QAResponse;
  /** 当前模式的徽章（label + 配色），由父级按 mode 解析好传入 */
  badge: { label: string; className: string };
  /** 多轮会话的轮数（>1 时显示「本次会话第 N 轮」） */
  conversationTurns: number;
  loading: boolean;
  copied: boolean;
  onCopy: () => void;

  followUpOpen: boolean;
  onFollowUpOpenChange: (open: boolean) => void;
  followUpQuery: string;
  onFollowUpQueryChange: (v: string) => void;
  followUpSubmitted: boolean;
  onFollowUpSubmittedChange: (v: boolean) => void;
  onSubmitFollowUp: () => void;
  onFollowUpCancel: () => void;

  feedbackOpen: boolean;
  onFeedbackOpenChange: (open: boolean) => void;
  feedbackText: string;
  onFeedbackTextChange: (v: string) => void;
  feedbackSubmitting: boolean;
  onFeedbackSubmit: (helpful: boolean) => void;
};

export function AnswerCard({
  result,
  badge,
  conversationTurns,
  loading,
  copied,
  onCopy,
  followUpOpen,
  onFollowUpOpenChange,
  followUpQuery,
  onFollowUpQueryChange,
  followUpSubmitted,
  onFollowUpSubmittedChange,
  onSubmitFollowUp,
  onFollowUpCancel,
  feedbackOpen,
  onFeedbackOpenChange,
  feedbackText,
  onFeedbackTextChange,
  feedbackSubmitting,
  onFeedbackSubmit,
}: AnswerCardProps) {
  const isRootCause = result.kind === 'root-cause';

  return (
    <Card>
      <CardHeader
        title={isRootCause ? '根因分析' : '回答'}
        icon={
          isRootCause ? (
            <svg className="w-4 h-4 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M5 19h14a2 2 0 001.84-2.75L13.74 4a2 2 0 00-3.5 0L3.16 16.25A2 2 0 005 19z" />
            </svg>
          ) : (
            <svg className="w-4 h-4 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
            </svg>
          )
        }
        iconClass={isRootCause
          ? 'bg-gradient-to-br from-rose-500 to-orange-500'
          : 'bg-gradient-to-br from-blue-500 to-indigo-600'}
        subtitle={
          <span className="flex items-center gap-2 flex-wrap">
            <span className={`px-1.5 py-0.5 rounded border text-[11px] font-medium ${badge.className}`}>
              {badge.label}
            </span>
            <span className="font-mono truncate max-w-[360px]" title={result.query}>{result.query}</span>
            {conversationTurns > 1 && (
              <span className="text-slate-400">· 本次会话第 {conversationTurns} 轮</span>
            )}
          </span>
        }
        right={
          <button
            onClick={onCopy}
            className="px-3 py-1.5 bg-white hover:bg-slate-50 text-slate-600 rounded-lg text-xs font-medium border border-slate-200 transition-all flex items-center gap-1.5"
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
        }
      />

      <div className="px-5 py-5">
        {isRootCause && (
          <div className="mb-4 flex items-start gap-2 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2">
            <svg className="w-4 h-4 text-rose-500 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <p className="text-xs leading-relaxed text-rose-900">
              以下是基于检索证据推断的<b>可能原因</b>，不是已验证的结论 —— 请对照下方证据自行判断。
            </p>
          </div>
        )}

        {/*
          引用一致性告警。
          后端会把答案里「证据中并不存在的文件:行号」挑出来放进 consistency。
          这是把「看起来最可信的错」显式暴露出来的一步：编造的行号与真实引用
          在格式上完全一样，不提示的话用户会默认它可核对。只提示、不改写答案。
        */}
        {result.consistency?.verdict === 'unsupported_refs' && (
          <div className="mb-4 flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2">
            <svg className="w-4 h-4 text-amber-600 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M5 19h14a2 2 0 001.84-2.75L13.74 4a2 2 0 00-3.5 0L3.16 16.25A2 2 0 005 19z" />
            </svg>
            <div className="text-xs leading-relaxed text-amber-900">
              <p className="font-medium">下方回答里有 {result.consistency.unsupported.length} 处引用不在本次检索到的证据中</p>
              <p className="mt-1">
                这些引用未经核实，可能并不存在。请以「检索证据」里的实际代码为准。
              </p>
              <p className="mt-1 font-mono text-[11px] text-amber-800 break-all">
                {result.consistency.unsupported.join('、')}
              </p>
            </div>
          </div>
        )}

        {result.consistency?.verdict === 'line_mismatch' && (
          <div className="mb-4 flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50/60 px-3 py-2">
            <svg className="w-4 h-4 text-amber-500 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <div className="text-xs leading-relaxed text-amber-900">
              <p>
                文件对得上，但有 {result.consistency.mismatchedLines.length} 处<b>行号</b>超出了证据覆盖的范围，
                行号可能不准确：
              </p>
              <p className="mt-1 font-mono text-[11px] text-amber-800 break-all">
                {result.consistency.mismatchedLines.join('、')}
              </p>
            </div>
          </div>
        )}

        <MarkdownBody>{result.answer}</MarkdownBody>

        {/* Follow-up question section */}
        {!followUpOpen ? (
          <div className="mt-5 pt-4 border-t border-slate-100">
            <button
              onClick={() => onFollowUpOpenChange(true)}
              className="flex items-center gap-2 text-blue-600 hover:text-blue-700 text-sm font-medium transition-colors"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
              </svg>
              继续提问
            </button>
          </div>
        ) : (
          <div className="mt-5 pt-4 border-t border-slate-100 space-y-3">
            <input
              type="text"
              placeholder="继续提问，例如：能详细说明一下这个函数的实现吗？"
              value={followUpQuery}
              onChange={(e) => onFollowUpQueryChange(e.target.value)}
              disabled={loading}
              className="w-full px-4 py-2 bg-slate-50 border border-slate-300 rounded-lg focus:border-blue-500 focus:ring-1 focus:ring-blue-500 transition-all disabled:opacity-50 text-slate-900 placeholder-slate-400 text-sm"
            />
            <div className="flex gap-2">
              <button
                onClick={() => {
                  onFollowUpSubmittedChange(true);
                  onSubmitFollowUp();
                }}
                disabled={loading || !followUpQuery.trim()}
                className="flex-1 bg-blue-600 text-white py-2 px-4 rounded-lg hover:bg-blue-700 disabled:bg-slate-300 disabled:text-slate-500 disabled:cursor-not-allowed font-medium transition-all text-sm"
              >
                {loading ? <LoadingSpinner className="h-4 w-4 border-white" /> : '提交'}
              </button>
              <button
                onClick={onFollowUpCancel}
                disabled={loading && !followUpSubmitted}
                className="px-4 py-2 bg-white border border-slate-300 text-slate-700 rounded-lg hover:bg-slate-50 disabled:opacity-50 disabled:cursor-not-allowed transition-all text-sm"
              >
                取消
              </button>
            </div>
          </div>
        )}

        {/* Historical Feedback Display */}
        {result.historicalFeedback && result.historicalFeedback.length > 0 && (
          <div className="mt-5 pt-5 border-t border-slate-100">
            <h4 className="text-sm font-semibold text-slate-900 mb-3 flex items-center">
              <svg className="w-4 h-4 mr-2 text-amber-500" fill="currentColor" viewBox="0 0 20 20">
                <path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z" />
              </svg>
              历史相关反馈
            </h4>
            <div className="space-y-2">
              {result.historicalFeedback.map((item, idx) => (
                <div key={idx} className="bg-slate-50 rounded-lg p-3 border border-slate-200">
                  <p className="text-xs text-slate-600 mb-2">相关问题: {item.query}</p>
                  {item.feedback.map((fb, fbIdx) => (
                    <div key={fbIdx} className="flex items-start gap-2 text-sm">
                      <span className={`mt-0.5 ${fb.is_helpful ? 'text-green-600' : 'text-orange-600'}`}>
                        {fb.is_helpful ? '✓' : '⚠'}
                      </span>
                      <span className="text-slate-700">{fb.feedback_text}</span>
                    </div>
                  ))}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Feedback Form */}
        {result.questionId && (
          <div className="mt-5 pt-5 border-t border-slate-100">
            {!feedbackOpen ? (
              <button
                onClick={() => onFeedbackOpenChange(true)}
                className="flex items-center gap-2 text-blue-600 hover:text-blue-700 font-medium transition-colors text-sm"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 8h10M7 12h4m1 8l-4-4H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-3l-4 4z" />
                </svg>
                添加反馈
              </button>
            ) : (
              <div className="space-y-3">
                <label className="block text-sm font-medium text-slate-900">您的反馈</label>
                <textarea
                  value={feedbackText}
                  onChange={(e) => onFeedbackTextChange(e.target.value)}
                  placeholder="例如：这个登录流程已经被废弃，现在使用 OAuth2.0 方式"
                  disabled={feedbackSubmitting}
                  className="w-full px-4 py-3 bg-white border border-slate-300 rounded-lg focus:border-blue-500 focus:ring-1 focus:ring-blue-500 transition-all disabled:opacity-50 text-slate-900 placeholder-slate-400 resize-none text-sm"
                  rows={3}
                />
                <div className="flex gap-2">
                  <button
                    onClick={() => onFeedbackSubmit(true)}
                    disabled={feedbackSubmitting || !feedbackText.trim()}
                    className="flex-1 bg-green-600 text-white py-2 px-4 rounded-lg hover:bg-green-700 disabled:bg-slate-300 disabled:text-slate-500 disabled:cursor-not-allowed font-medium transition-all text-sm"
                  >
                    {feedbackSubmitting ? <LoadingSpinner className="h-4 w-4 border-white" /> : '✓ 有帮助'}
                  </button>
                  <button
                    onClick={() => onFeedbackSubmit(false)}
                    disabled={feedbackSubmitting || !feedbackText.trim()}
                    className="flex-1 bg-orange-600 text-white py-2 px-4 rounded-lg hover:bg-orange-700 disabled:bg-slate-300 disabled:text-slate-500 disabled:cursor-not-allowed font-medium transition-all text-sm"
                  >
                    {feedbackSubmitting ? <LoadingSpinner className="h-4 w-4 border-white" /> : '⚠ 需修正'}
                  </button>
                  <button
                    onClick={() => {
                      onFeedbackOpenChange(false);
                      onFeedbackTextChange('');
                    }}
                    disabled={feedbackSubmitting}
                    className="px-4 py-2 bg-white border border-slate-300 text-slate-700 rounded-lg hover:bg-slate-50 disabled:cursor-not-allowed transition-all text-sm"
                  >
                    取消
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </Card>
  );
}
