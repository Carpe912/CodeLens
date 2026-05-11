interface CacheEntry<T> {
  value: T;
  timestamp: number;
}

export class SearchCache {
  private cache: Map<string, CacheEntry<any>> = new Map();
  private ttl: number = 5 * 60 * 1000; // 5 minutes

  set<T>(key: string, value: T) {
    this.cache.set(key, {
      value,
      timestamp: Date.now(),
    });
  }

  get<T>(key: string): T | undefined {
    const entry = this.cache.get(key);
    if (!entry) {
      return undefined;
    }

    if (Date.now() - entry.timestamp > this.ttl) {
      this.cache.delete(key);
      return undefined;
    }

    return entry.value as T;
  }

  clear() {
    this.cache.clear();
  }

  clearByPrefix(prefix: string) {
    for (const key of this.cache.keys()) {
      if (key.startsWith(prefix)) {
        this.cache.delete(key);
      }
    }
  }

  generateKey(repoId: number, query: string): string {
    return `${repoId}:${query}`;
  }
}

export interface SearchHistoryItem {
  query: string;
  timestamp: number;
  mode: 'search' | 'ask' | 'rootCause';
}

export class SearchHistory {
  private maxItems: number = 50;

  constructor(private context: any) {}

  addItem(query: string, mode: 'search' | 'ask' | 'rootCause') {
    const history = this.getHistory();

    // Remove duplicate if exists
    const filtered = history.filter(item => item.query !== query || item.mode !== mode);

    // Add new item at the beginning
    filtered.unshift({
      query,
      timestamp: Date.now(),
      mode,
    });

    // Keep only maxItems
    const trimmed = filtered.slice(0, this.maxItems);

    this.saveHistory(trimmed);
  }

  getHistory(): SearchHistoryItem[] {
    const history = this.context.globalState.get('codelens.searchHistory');
    return (history as SearchHistoryItem[]) || [];
  }

  clearHistory() {
    this.context.globalState.update('codelens.searchHistory', []);
  }

  private saveHistory(history: SearchHistoryItem[]) {
    this.context.globalState.update('codelens.searchHistory', history);
  }
}
