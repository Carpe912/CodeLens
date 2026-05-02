/**
 * Search suggestions and spell correction utilities
 */

/**
 * Calculate Levenshtein distance between two strings
 */
function levenshteinDistance(a: string, b: string): number {
  const matrix: number[][] = [];

  for (let i = 0; i <= b.length; i++) {
    matrix[i] = [i];
  }

  for (let j = 0; j <= a.length; j++) {
    matrix[0][j] = j;
  }

  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      if (b.charAt(i - 1) === a.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1, // substitution
          matrix[i][j - 1] + 1, // insertion
          matrix[i - 1][j] + 1 // deletion
        );
      }
    }
  }

  return matrix[b.length][a.length];
}

/**
 * Calculate similarity ratio between two strings (0-1)
 */
function similarityRatio(a: string, b: string): number {
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1.0;
  const distance = levenshteinDistance(a.toLowerCase(), b.toLowerCase());
  return 1 - distance / maxLen;
}

/**
 * Find similar terms from a dictionary
 */
export function findSimilarTerms(
  query: string,
  dictionary: string[],
  threshold: number = 0.6,
  maxResults: number = 5
): Array<{ term: string; similarity: number }> {
  const queryLower = query.toLowerCase();

  const similarities = dictionary
    .map((term) => ({
      term,
      similarity: similarityRatio(queryLower, term.toLowerCase()),
    }))
    .filter((item) => item.similarity >= threshold)
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, maxResults);

  return similarities;
}

/**
 * Common programming typos and corrections
 */
const COMMON_TYPOS: Record<string, string> = {
  // Common misspellings
  fucntion: 'function',
  funciton: 'function',
  retrun: 'return',
  reutrn: 'return',
  cosnt: 'const',
  conts: 'const',
  improt: 'import',
  imoprt: 'import',
  exoprt: 'export',
  exprot: 'export',
  calss: 'class',
  clsas: 'class',
  interfce: 'interface',
  interafce: 'interface',
  asynch: 'async',
  awiat: 'await',
  promies: 'promise',
  promse: 'promise',
  obejct: 'object',
  ojbect: 'object',
  arary: 'array',
  arry: 'array',
  lenght: 'length',
  heigth: 'height',
  widht: 'width',

  // HTTP methods
  gt: 'get',
  pst: 'post',
  delte: 'delete',
  delet: 'delete',

  // Common API terms
  athentication: 'authentication',
  authetication: 'authentication',
  autorization: 'authorization',
  authroization: 'authorization',
  valiation: 'validation',
  validtion: 'validation',
};

/**
 * Correct common typos in query
 */
export function correctTypos(query: string): { corrected: string; hasCorrected: boolean } {
  const words = query.split(/\s+/);
  let hasCorrected = false;

  const correctedWords = words.map((word) => {
    const lowerWord = word.toLowerCase();
    if (COMMON_TYPOS[lowerWord]) {
      hasCorrected = true;
      return COMMON_TYPOS[lowerWord];
    }
    return word;
  });

  return {
    corrected: correctedWords.join(' '),
    hasCorrected,
  };
}

/**
 * Extract keywords from camelCase or snake_case
 */
export function extractKeywords(text: string): string[] {
  // Split by camelCase
  const camelCaseSplit = text.replace(/([a-z])([A-Z])/g, '$1 $2');

  // Split by snake_case, kebab-case, and spaces
  const words = camelCaseSplit
    .split(/[_\-\s]+/)
    .filter((word) => word.length > 0)
    .map((word) => word.toLowerCase());

  return [...new Set(words)];
}

/**
 * Generate search suggestions based on query
 */
export interface SearchSuggestion {
  type: 'typo' | 'similar' | 'keyword';
  original: string;
  suggestion: string;
  reason: string;
}

export function generateSuggestions(
  query: string,
  availableTerms: string[] = []
): SearchSuggestion[] {
  const suggestions: SearchSuggestion[] = [];

  // Check for typos
  const { corrected, hasCorrected } = correctTypos(query);
  if (hasCorrected) {
    suggestions.push({
      type: 'typo',
      original: query,
      suggestion: corrected,
      reason: 'Corrected common typos',
    });
  }

  // Find similar terms
  if (availableTerms.length > 0) {
    const queryWords = query.split(/\s+/);

    for (const word of queryWords) {
      if (word.length < 3) continue; // Skip short words

      const similar = findSimilarTerms(word, availableTerms, 0.7, 3);

      for (const { term, similarity } of similar) {
        if (term.toLowerCase() !== word.toLowerCase()) {
          suggestions.push({
            type: 'similar',
            original: word,
            suggestion: term,
            reason: `Did you mean "${term}"? (${Math.round(similarity * 100)}% match)`,
          });
        }
      }
    }
  }

  // Extract keywords for better search
  const keywords = extractKeywords(query);
  if (keywords.length > 1 && keywords.join(' ') !== query.toLowerCase()) {
    suggestions.push({
      type: 'keyword',
      original: query,
      suggestion: keywords.join(' '),
      reason: 'Extracted keywords from compound terms',
    });
  }

  return suggestions;
}

/**
 * Build a dictionary from search history
 */
export class SearchDictionary {
  private terms: Set<string> = new Set();

  addTerm(term: string): void {
    const keywords = extractKeywords(term);
    keywords.forEach((keyword) => {
      if (keyword.length >= 3) {
        this.terms.add(keyword);
      }
    });
  }

  addTerms(terms: string[]): void {
    terms.forEach((term) => this.addTerm(term));
  }

  getTerms(): string[] {
    return Array.from(this.terms);
  }

  clear(): void {
    this.terms.clear();
  }
}
