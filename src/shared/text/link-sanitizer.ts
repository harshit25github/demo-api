const HTML_ANCHOR_PATTERN = /<a\b[^>]*href\s*=\s*["'][^"']+["'][^>]*>(.*?)<\/a>/gis;
const MARKDOWN_LINK_PATTERN = /\[([^\]\n]+)\]\(((?:https?:\/\/|www\.|[a-z0-9.-]+\.[a-z]{2,})[^)\s]*)[^)]*\)/gi;
const RAW_URL_PATTERN = /\b(?:https?:\/\/|www\.)[^\s<>()\]]+/gi;
const BARE_DOMAIN_PATTERN =
  /\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:com|org|net|gov|edu|io|co|travel|info|biz|in|uk|us|ca|au|de|fr|it|es|ae|sg|jp|cn|me|app|dev)(?:\/[^\s<>()\]]*)?/gi;

function stripHtmlTags(value: string) {
  return String(value || '').replace(/<[^>]+>/g, '').trim();
}

function normalizeWhitespace(value: string) {
  return value
    .replace(/^.*\b(?:citations?|sources?|links?)\b.*\b(?:clickable|below|above|included|provided|attached)\b.*$/gim, '')
    .replace(/\s*\(\s*\)/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[ \t]+([,.!?;:])/g, '$1')
    .trim();
}

function testPattern(pattern: RegExp, value: string): boolean {
  pattern.lastIndex = 0;
  return pattern.test(value);
}

export function sanitizeNoLinks(text = '') {
  const original = String(text || '');
  let removedCount = 0;

  let sanitized = original.replace(HTML_ANCHOR_PATTERN, (_match, label) => {
    removedCount += 1;
    return stripHtmlTags(label);
  });

  sanitized = sanitized.replace(MARKDOWN_LINK_PATTERN, (_match, label) => {
    removedCount += 1;
    return label.trim();
  });

  sanitized = sanitized.replace(RAW_URL_PATTERN, () => {
    removedCount += 1;
    return '';
  });

  sanitized = sanitized.replace(BARE_DOMAIN_PATTERN, () => {
    removedCount += 1;
    return '';
  });

  sanitized = normalizeWhitespace(sanitized);

  return {
    text: sanitized,
    changed: sanitized !== original,
    removedCount,
  };
}

export function containsLinkLikeText(text = ''): boolean {
  const value = String(text || '');
  return (
    testPattern(HTML_ANCHOR_PATTERN, value) ||
    testPattern(MARKDOWN_LINK_PATTERN, value) ||
    testPattern(RAW_URL_PATTERN, value) ||
    testPattern(BARE_DOMAIN_PATTERN, value)
  );
}

export function assertNoLinks(text = ''): void {
  if (containsLinkLikeText(text)) {
    throw new Error('Reply failed no-link validation.');
  }
}
