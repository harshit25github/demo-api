const HTML_ANCHOR_PATTERN = /<a\b[^>]*href\s*=\s*["'][^"']+["'][^>]*>(.*?)<\/a>/gis;
const MARKDOWN_LINK_PATTERN = /\[([^\]\n]+)\]\(((?:https?:\/\/|www\.|[a-z0-9.-]+\.[a-z]{2,})[^)\s]*)[^)]*\)/gi;
const RAW_URL_PATTERN = /\b(?:https?:\/\/|www\.)[^\s<>()\]]+/gi;
const BARE_DOMAIN_PATTERN =
  /\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:com|org|net|gov|edu|io|co|travel|info|biz|in|uk|us|ca|au|de|fr|it|es|ae|sg|jp|cn|me|app|dev)(?:\/[^\s<>()\]]*)?/gi;
const CARD_MARKER = ':::cards';
const CARD_IMAGE_LINE_PATTERN = /^(\s*image:\s*)(https?:\/\/\S+)(\s*)$/i;

interface LinkSanitizerOptions {
  preserveCardImageUrls?: boolean;
  allowCardImageUrls?: boolean;
}

function protectCardImageUrls(text: string) {
  const protectedUrls: string[] = [];
  const lines = String(text || '').split('\n');
  const markerIndexes = lines
    .map((line, index) => (line.trim() === CARD_MARKER ? index : null))
    .filter((index) => index !== null);
  const protectedLineIndexes = new Set();
  for (let index = 0; index + 1 < markerIndexes.length; index += 2) {
    for (
      let lineIndex = markerIndexes[index] + 1;
      lineIndex < markerIndexes[index + 1];
      lineIndex += 1
    ) {
      protectedLineIndexes.add(lineIndex);
    }
  }

  const protectedText = lines
    .map((line, lineIndex) => {
      if (!protectedLineIndexes.has(lineIndex)) {
        return line;
      }
      return line.replace(CARD_IMAGE_LINE_PATTERN, (_match, prefix, url, suffix) => {
        const token = `__TRIP_PLANNER_CARD_IMAGE_${protectedUrls.length}__`;
        protectedUrls.push(url);
        return `${prefix}${token}${suffix}`;
      });
    })
    .join('\n');

  return {
    text: protectedText,
    restore(value: string) {
      return protectedUrls.reduce(
        (result, url, index) =>
          result.replace(`__TRIP_PLANNER_CARD_IMAGE_${index}__`, url),
        value,
      );
    },
  };
}

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

export function sanitizeNoLinks(
  text = '',
  { preserveCardImageUrls = false }: LinkSanitizerOptions = {},
) {
  const original = String(text || '');
  const protectedCardImages = preserveCardImageUrls
    ? protectCardImageUrls(original)
    : { text: original, restore: (value: string) => value };
  let removedCount = 0;

  let sanitized = protectedCardImages.text.replace(HTML_ANCHOR_PATTERN, (_match, label) => {
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

  sanitized = protectedCardImages.restore(normalizeWhitespace(sanitized));

  return {
    text: sanitized,
    changed: sanitized !== original,
    removedCount,
  };
}

export function containsLinkLikeText(
  text = '',
  { allowCardImageUrls = false }: LinkSanitizerOptions = {},
): boolean {
  const original = String(text || '');
  const value = allowCardImageUrls ? protectCardImageUrls(original).text : original;
  return (
    testPattern(HTML_ANCHOR_PATTERN, value) ||
    testPattern(MARKDOWN_LINK_PATTERN, value) ||
    testPattern(RAW_URL_PATTERN, value) ||
    testPattern(BARE_DOMAIN_PATTERN, value)
  );
}

export function assertNoLinks(text = '', options: LinkSanitizerOptions = {}): void {
  if (containsLinkLikeText(text, options)) {
    throw new Error('Trip Planner output failed no-link validation.');
  }
}
