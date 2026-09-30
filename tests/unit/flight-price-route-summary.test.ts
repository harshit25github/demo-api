import assert from 'node:assert/strict';
import test from 'node:test';
import { buildPricePredictionRouteSummary } from '../../src/agents/flight/context/prompt-summary.js';

test('price prediction reuses a known metropolitan code from the current search', () => {
  const context = {
    flight: {
      segments: [{ origin: 'NYC', destination: 'London', date: '2026-11-05' }],
      outboundDate: '2026-11-05',
      inboundDate: '2026-11-12',
    },
  };
  assert.equal(buildPricePredictionRouteSummary(context), 'NYC to LON');
});

test('price prediction does not invent a code for an unknown city', () => {
  const context = {
    flight: {
      segments: [{ origin: 'NYC', destination: 'Unknown City', date: '2026-11-05' }],
      resolvedDestination: { userCity: 'London', airportIATA: 'LON' },
    },
  };
  assert.equal(buildPricePredictionRouteSummary(context), 'unresolved');
});
