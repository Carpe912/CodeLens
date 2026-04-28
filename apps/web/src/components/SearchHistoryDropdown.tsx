import { SearchHistoryItem } from '../types';
import { getSearchResult, clearSearchHistory } from '../utils/searchHistory';

type SearchHistoryDropdownProps = {
  searchHistory: SearchHistoryItem[];
  repoId: string;
  onSelectHistory: (item: SearchHistoryItem, savedResult: any) => void;
  onClear: () => void;
};

export function SearchHistoryDropdown({
  searchHistory,
  repoId,
  onSelectHistory,
  onClear,
}: SearchHistoryDropdownProps) {
  const filteredHistory = searchHistory.filter(item => item.repoId === repoId);

  if (filteredHistory.length === 0) {
    return null;
  }

  return (
    <div className="absolute top-full left-0 right-0 mt-2 bg-slate-800 border border-slate-700 rounded-xl shadow-2xl z-10 max-h-60 overflow-y-auto">
      <div className="flex items-center justify-between px-4 py-3 border-b border-slate-700">
        <span className="text-sm text-gray-400 font-medium">搜索历史</span>
        <button
          onClick={onClear}
          className="text-xs text-red-400 hover:text-red-300 transition-colors"
        >
          清空
        </button>
      </div>
      {filteredHistory.map((item: SearchHistoryItem) => (
        <div
          key={item.id}
          onClick={() => {
            const savedResult = getSearchResult(item.id);
            onSelectHistory(item, savedResult);
          }}
          className="px-4 py-3 hover:bg-slate-700/50 cursor-pointer transition-colors border-b border-slate-700/30 last:border-b-0"
        >
          <div className="flex items-center justify-between gap-3">
            <div className="flex-1 min-w-0">
              <div className="text-gray-300 text-sm truncate">{item.query}</div>
              <div className="text-xs text-gray-500 mt-1">
                {new Date(item.timestamp).toLocaleString('zh-CN')}
              </div>
            </div>
            <span className={`px-2 py-0.5 rounded text-xs font-medium flex-shrink-0 ${
              item.mode === 'search' ? 'bg-cyan-500/20 text-cyan-400' :
              item.mode === 'ask' ? 'bg-emerald-500/20 text-emerald-400' :
              'bg-purple-500/20 text-purple-400'
            }`}>
              {item.mode === 'search' ? '搜索' : item.mode === 'ask' ? '问答' : '根因'}
            </span>
          </div>
        </div>
      ))}
    </div>
  );
}
