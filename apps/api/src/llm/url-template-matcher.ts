/**
 * URL Template Matcher - Match dynamic URLs against template patterns
 *
 * Handles cases like:
 * - Template: `/rest/enterprise/project/${pid}`
 * - Query: `/rest/enterprise/project/5eda325a2f391b475a711a7b`
 * - Match: YES, with extracted params: { pid: '5eda325a2f391b475a711a7b' }
 */

export interface TemplateMatch {
  template: string;
  score: number;
  extractedParams: Record<string, string>;
  segments: {
    static: string[];
    dynamic: string[];
  };
}

/**
 * Match a URL against template patterns
 */
export function matchURLTemplate(url: string, template: string): TemplateMatch | null {
  // Normalize URLs (remove protocol, domain, trailing slashes)
  const normalizedURL = normalizeURL(url);
  const normalizedTemplate = normalizeURL(template);

  // Extract static and dynamic segments from template
  const templateSegments = parseTemplate(normalizedTemplate);
  const urlSegments = normalizedURL.split('/').filter(s => s);

  // Check if segment counts match
  if (urlSegments.length !== templateSegments.length) {
    return null;
  }

  // Match each segment
  const extractedParams: Record<string, string> = {};
  let matchedStatic = 0;
  let totalStatic = 0;

  for (let i = 0; i < templateSegments.length; i++) {
    const templateSeg = templateSegments[i];
    const urlSeg = urlSegments[i];

    if (templateSeg.type === 'static') {
      totalStatic++;
      if (templateSeg.value.toLowerCase() === urlSeg.toLowerCase()) {
        matchedStatic++;
      } else {
        // Static segment mismatch - not a match
        return null;
      }
    } else if (templateSeg.type === 'dynamic') {
      // Dynamic segment - extract parameter
      extractedParams[templateSeg.name] = urlSeg;
    }
  }

  // Calculate match score
  const score = totalStatic > 0 ? matchedStatic / totalStatic : 1.0;

  return {
    template: normalizedTemplate,
    score,
    extractedParams,
    segments: {
      static: templateSegments.filter(s => s.type === 'static').map(s => s.value),
      dynamic: templateSegments.filter(s => s.type === 'dynamic').map(s => s.name),
    },
  };
}

/**
 * Normalize URL by removing protocol, domain, and trailing slashes
 */
function normalizeURL(url: string): string {
  let normalized = url;

  // Remove protocol and domain
  normalized = normalized.replace(/^https?:\/\/[^\/]+/, '');

  // Remove trailing slash
  normalized = normalized.replace(/\/$/, '');

  // Remove leading slash for consistency
  normalized = normalized.replace(/^\//, '');

  return normalized;
}

/**
 * Parse template into segments
 */
interface TemplateSegment {
  type: 'static' | 'dynamic';
  value: string;
  name: string;
}

function parseTemplate(template: string): TemplateSegment[] {
  const segments: TemplateSegment[] = [];
  const parts = template.split('/').filter(s => s);

  for (const part of parts) {
    // Check for template variable patterns:
    // 1. ${varName} - ES6 template literal
    // 2. :varName - Express/React Router style
    // 3. {varName} - OpenAPI style
    // 4. <varName> - Angular style

    const es6Match = part.match(/^\$\{([^}]+)\}$/);
    const colonMatch = part.match(/^:([a-zA-Z_][a-zA-Z0-9_]*)$/);
    const braceMatch = part.match(/^\{([^}]+)\}$/);
    const angleMatch = part.match(/^<([^>]+)>$/);

    if (es6Match) {
      segments.push({
        type: 'dynamic',
        value: part,
        name: es6Match[1],
      });
    } else if (colonMatch) {
      segments.push({
        type: 'dynamic',
        value: part,
        name: colonMatch[1],
      });
    } else if (braceMatch) {
      segments.push({
        type: 'dynamic',
        value: part,
        name: braceMatch[1],
      });
    } else if (angleMatch) {
      segments.push({
        type: 'dynamic',
        value: part,
        name: angleMatch[1],
      });
    } else {
      segments.push({
        type: 'static',
        value: part,
        name: '',
      });
    }
  }

  return segments;
}

/**
 * Check if a string contains template variables
 */
export function isTemplate(str: string): boolean {
  return /\$\{[^}]+\}|:[a-zA-Z_][a-zA-Z0-9_]*|\{[^}]+\}|<[^>]+>/.test(str);
}

/**
 * Extract all template variable names from a template string
 */
export function extractTemplateVars(template: string): string[] {
  const vars: string[] = [];
  const segments = parseTemplate(template);

  for (const seg of segments) {
    if (seg.type === 'dynamic') {
      vars.push(seg.name);
    }
  }

  return vars;
}

/**
 * Calculate similarity between two URLs (for fuzzy matching)
 */
export function calculateURLSimilarity(url1: string, url2: string): number {
  const norm1 = normalizeURL(url1);
  const norm2 = normalizeURL(url2);

  const segs1 = norm1.split('/').filter(s => s);
  const segs2 = norm2.split('/').filter(s => s);

  // If different number of segments, calculate based on overlap
  const minLen = Math.min(segs1.length, segs2.length);
  const maxLen = Math.max(segs1.length, segs2.length);

  let matches = 0;
  for (let i = 0; i < minLen; i++) {
    if (segs1[i].toLowerCase() === segs2[i].toLowerCase()) {
      matches++;
    }
  }

  return matches / maxLen;
}
