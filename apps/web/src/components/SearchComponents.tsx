import { ChangeEvent, KeyboardEvent } from 'react';
import { LoadingSpinner } from './common/LoadingSpinner';

type ModeType = 'search' | 'ask' | 'root-cause';

type ModeSelectorProps = {
  mode: ModeType;
  onModeChange: (mode: ModeType) => void;
};

export function ModeSelector({ mode, onModeChange }: ModeSelectorProps) {
  return (
    <div className="mb-4 bg-slate-800/50 backdrop-blur-xl rounded-xl p-1.5 border border-slate-700/50 inline-flex gap-1.5">
      <button
        onClick={() => onModeChange('search')}
        className={`px-4 py-2 rounded-lg font-medium transition-all text-sm ${
          mode === 'search'
            ? 'bg-gradient-to-r from-cyan-500 to-blue-600 text-white shadow-lg shadow-cyan-500/50'
            : 'text-gray-400 hover:text-gray-300 hover:bg-slate-700/50'
        }`}
      >
        <div className="flex items-center gap-1.5">
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
          搜索
        </div>
      </button>
      <button
        onClick={() => onModeChange('ask')}
        className={`px-4 py-2 rounded-lg font-medium transition-all text-sm ${
          mode === 'ask'
            ? 'bg-gradient-to-r from-emerald-500 to-green-600 text-white shadow-lg shadow-emerald-500/50'
            : 'text-gray-400 hover:text-gray-300 hover:bg-slate-700/50'
        }`}
      >
        <div className="flex items-center gap-1.5">
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z" />
          </svg>
          问答
        </div>
      </button>
      <button
        onClick={() => onModeChange('root-cause')}
        className={`px-4 py-2 rounded-lg font-medium transition-all text-sm ${
          mode === 'root-cause'
            ? 'bg-gradient-to-r from-purple-500 to-pink-600 text-white shadow-lg shadow-purple-500/50'
            : 'text-gray-400 hover:text-gray-300 hover:bg-slate-700/50'
        }`}
      >
        <div className="flex items-center gap-1.5">
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" />
          </svg>
          根因分析
        </div>
      </button>
    </div>
  );
}

type SearchBoxProps = {
  query: string;
  mode: ModeType;
  loading: boolean;
  onQueryChange: (query: string) => void;
  onSubmit: () => void;
  onFocus: () => void;
  onBlur: () => void;
  onKeyDown: (e: KeyboardEvent<HTMLInputElement>) => void;
  children?: React.ReactNode;
};

export function SearchBox({
  query,
  mode,
  loading,
  onQueryChange,
  onSubmit,
  onFocus,
  onBlur,
  onKeyDown,
  children,
}: SearchBoxProps) {
  const placeholder =
    mode === 'search'
      ? '🔍 搜索代码片段、函数、类...'
      : mode === 'ask'
      ? '💬 提问：登录方案是什么？'
      : '🔧 描述 bug：登录一天要登录好几次';

  return (
    <div className="mb-6 relative">
      <div className="bg-slate-800/50 backdrop-blur-xl rounded-xl p-4 border border-slate-700/50 shadow-2xl">
        <div className="flex gap-2">
          <div className="flex-1 relative">
            <input
              type="text"
              placeholder={placeholder}
              value={query}
              onChange={(e: ChangeEvent<HTMLInputElement>) => onQueryChange(e.target.value)}
              onKeyDown={onKeyDown}
              onFocus={onFocus}
              onBlur={onBlur}
              disabled={loading}
              className="w-full px-4 py-2.5 bg-slate-900/50 border-2 border-slate-600 rounded-lg focus:border-cyan-500 focus:ring-2 focus:ring-cyan-500/50 transition-all disabled:opacity-50 text-gray-200 placeholder-gray-500 text-sm"
            />
            {children}
          </div>

          <button
            onClick={onSubmit}
            disabled={loading || !query}
            className="px-6 py-2.5 bg-gradient-to-r from-cyan-500 to-blue-600 text-white rounded-lg hover:from-cyan-600 hover:to-blue-700 disabled:from-gray-600 disabled:to-gray-600 disabled:cursor-not-allowed font-semibold shadow-lg hover:shadow-cyan-500/50 transition-all flex items-center justify-center min-w-[100px] text-sm"
          >
            {loading ? <LoadingSpinner /> : '提交'}
          </button>
        </div>
      </div>
    </div>
  );
}
