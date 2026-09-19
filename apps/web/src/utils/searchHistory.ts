import { QAResponse, SearchHistoryItem } from '../types';

const SEARCH_HISTORY_KEY = 'codelens_search_history';
const SEARCH_RESULTS_KEY = 'codelens_search_results';
const MAX_HISTORY_ITEMS = 10;

export function getSearchHistory(): SearchHistoryItem[] {
  try {
    const history = localStorage.getItem(SEARCH_HISTORY_KEY);
    return history ? JSON.parse(history) : [];
  } catch {
    return [];
  }
}

export function addToSearchHistory(
  query: string,
  mode: 'search' | 'ask' | 'root-cause',
  repoId: string,
  result: QAResponse
) {
  const history = getSearchHistory();
  const id = `${Date.now()}-${Math.random()}`;
  const newItem: SearchHistoryItem = {
    id,
    query,
    mode,
    timestamp: Date.now(),
    repoId,
  };

  // Save result separately
  try {
    const results = JSON.parse(localStorage.getItem(SEARCH_RESULTS_KEY) || '{}');
    results[id] = result;
    localStorage.setItem(SEARCH_RESULTS_KEY, JSON.stringify(results));
  } catch (e) {
    console.error('Failed to save search result:', e);
  }

  const updated = [newItem, ...history].slice(0, MAX_HISTORY_ITEMS);
  localStorage.setItem(SEARCH_HISTORY_KEY, JSON.stringify(updated));
}

export function getSearchResult(id: string): QAResponse | null {
  try {
    const results = JSON.parse(localStorage.getItem(SEARCH_RESULTS_KEY) || '{}');
    return results[id] || null;
  } catch {
    return null;
  }
}

export function clearSearchHistory() {
  localStorage.removeItem(SEARCH_HISTORY_KEY);
  localStorage.removeItem(SEARCH_RESULTS_KEY);
}
