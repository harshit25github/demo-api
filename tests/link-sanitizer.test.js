import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  assertNoLinks,
  containsLinkLikeText,
  sanitizeNoLinks,
} from '../src/flight-agent/linkSanitizer.js';

describe('link sanitizer', () => {
  it('removes raw urls', () => {
    const result = sanitizeNoLinks('Visit https://example.com/dubai for details.');

    assert.equal(result.text, 'Visit for details.');
    assert.equal(containsLinkLikeText(result.text), false);
    assert.equal(result.removedCount, 1);
  });

  it('converts markdown links to labels', () => {
    const result = sanitizeNoLinks('See [Burj Khalifa](https://example.com/burj) today.');

    assert.equal(result.text, 'See Burj Khalifa today.');
    assert.equal(containsLinkLikeText(result.text), false);
  });

  it('converts html anchors to labels', () => {
    const result = sanitizeNoLinks('Try <a href="https://example.com">Dubai Mall</a>.');

    assert.equal(result.text, 'Try Dubai Mall.');
    assert.equal(containsLinkLikeText(result.text), false);
  });

  it('removes bare link-like domains', () => {
    const result = sanitizeNoLinks('Check example.com/dubai before going.');

    assert.equal(result.text, 'Check before going.');
    assert.equal(containsLinkLikeText(result.text), false);
  });

  it('removes empty parentheses left after url stripping', () => {
    const result = sanitizeNoLinks('Visit Burj Khalifa (https://example.com/burj) today.');

    assert.equal(result.text, 'Visit Burj Khalifa today.');
    assert.equal(containsLinkLikeText(result.text), false);
  });

  it('removes source/link boilerplate lines', () => {
    const result = sanitizeNoLinks(
      'The citations below are clickable links.\n\nDay 1: Visit Dubai Mall.',
    );

    assert.equal(result.text, 'Day 1: Visit Dubai Mall.');
    assert.equal(containsLinkLikeText(result.text), false);
  });

  it('leaves clean itinerary text unchanged', () => {
    const text = 'Day 1: Dubai Mall, Burj Khalifa, and Dubai Fountain.';
    const result = sanitizeNoLinks(text);

    assert.equal(result.text, text);
    assert.equal(result.changed, false);
    assert.doesNotThrow(() => assertNoLinks(result.text));
  });

  it('throws when link-like text remains', () => {
    assert.throws(() => assertNoLinks('Open https://example.com'), /no-link validation/);
  });
});
