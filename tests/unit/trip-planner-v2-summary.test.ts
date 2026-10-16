/** Client summary contract for Trip Planner v2. Cases marked "extractor" come from src/agents/summary/prompt.ts. */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyTripChanges,
  createClientSummary,
  durationFromDates,
  validateClientSummary,
} from '../../src/agents/trip-planner-v2/client-summary.js';
import { summaryAgentContextSchema } from '../../src/agents/summary/schema.js';
import type { TripChanges } from '../../src/agents/trip-planner-v2/result.js';

const NO_CHANGES: TripChanges = {
  origin: null, destination: null, outbound_date: null, return_date: null, duration_days: null,
  budget: null, tripType: null, passengerData: null, clear: [],
};
const changes = (fields: Partial<TripChanges>): TripChanges => ({ ...NO_CHANGES, ...fields });
const passengers = (fields: Partial<NonNullable<TripChanges['passengerData']>>) => ({
  total: null, adults: null, seniors: null, children: null, lapInfants: null, seatInfants: null, childrenAges: [], ...fields,
});

const CLIENT_EXAMPLE = {
  origin: { city: 'NEWDELHI', iata: 'DEL' },
  destination: { city: null, iata: null },
  outbound_date: null,
  return_date: null,
  duration_days: null,
  budget: { amount: null, currency: 'USD', per_person: false, total: null },
  tripType: [],
  placesOfInterest: [],
  passengerData: { total: null, adults: null, seniors: null, children: null, lapInfants: null, seatInfants: null, childrenAges: [] },
};

test('the client summary keeps exactly the client keys and order', () => {
  const summary = createClientSummary({});
  assert.deepEqual(Object.keys(summary), [
    'origin', 'destination', 'outbound_date', 'return_date', 'duration_days', 'budget', 'tripType', 'placesOfInterest', 'passengerData',
  ]);
  assert.deepEqual(Object.keys(summary.budget), ['amount', 'currency', 'per_person', 'total']);
  assert.deepEqual(Object.keys(summary.passengerData), ['total', 'adults', 'seniors', 'children', 'lapInfants', 'seatInfants', 'childrenAges']);
  assert.equal(validateClientSummary(summary).ok, true);
});

test("the client's example passes through unchanged and matches the Summary Extractor schema", () => {
  const summary = createClientSummary(structuredClone(CLIENT_EXAMPLE));
  assert.deepEqual(summary, CLIENT_EXAMPLE);
  assert.equal(JSON.stringify(summary), JSON.stringify(CLIENT_EXAMPLE));
  assert.equal(summaryAgentContextSchema.safeParse(summary).success, true);
});

test("v1's Trip-only summary converts: pax becomes passengerData.total and Trip-only keys drop", () => {
  const summary = createClientSummary({
    pax: 3, upcomingEvents: [{ name: 'Night market' }], suggestedQuestions: ['Add a food tour'],
    destination: { city: 'Paris', iata: 'par' }, tripType: ['family', 'Family', 'food'],
  });
  assert.equal(summary.passengerData.total, 3);
  assert.equal(summary.destination.iata, 'PAR');
  assert.deepEqual(summary.tripType, ['family', 'food']);
  for (const key of ['pax', 'upcomingEvents', 'suggestedQuestions']) assert.equal(Object.hasOwn(summary, key), false);
});

test('extractor: a stated breakdown with a child age keeps the journey type and adds no family', () => {
  const { summary } = applyTripChanges({ tripType: ['oneway'] },
    changes({ passengerData: passengers({ total: 3, adults: 2, children: 1, childrenAges: [8] }) }));
  assert.deepEqual(summary.passengerData, { total: 3, adults: 2, seniors: null, children: 1, lapInfants: null, seatInfants: null, childrenAges: [8] });
  assert.deepEqual(summary.tripType, ['oneway']);
});

test('extractor: a third traveler of unknown category keeps known adults and drops stale zeros', () => {
  const { summary } = applyTripChanges(
    { passengerData: { total: 2, adults: 2, seniors: 0, children: 0, lapInfants: 0, seatInfants: 0, childrenAges: [] } },
    changes({ passengerData: passengers({ total: 3 }) }),
  );
  assert.deepEqual(summary.passengerData, { total: 3, adults: 2, seniors: null, children: null, lapInfants: null, seatInfants: null, childrenAges: [] });
  assert.equal(validateClientSummary(summary).ok, true);
});

test('extractor: more travelers remove solo above one and couple above two', () => {
  assert.deepEqual(applyTripChanges({ tripType: ['solo', 'food'] }, changes({ passengerData: passengers({ total: 2 }) })).summary.tripType, ['food']);
  assert.deepEqual(applyTripChanges({ tripType: ['couple', 'food'] }, changes({ passengerData: passengers({ total: 3 }) })).summary.tripType, ['food']);
});

test('extractor: a new journey type, pace or party replaces only its own category', () => {
  const { summary } = applyTripChanges({ tripType: ['roundtrip', 'balanced', 'couple', 'food'] },
    changes({ tripType: { add: ['One-way', 'relaxed', 'family'], remove: [] } }));
  assert.deepEqual([...summary.tripType].sort(), ['family', 'food', 'oneway', 'relaxed']);
});

test('extractor: budget total follows the stated basis and never assumes one', () => {
  const perPerson = applyTripChanges({ passengerData: passengers({ total: 2 }) },
    changes({ budget: { amount: 1500, currency: 'usd', per_person: true } })).summary.budget;
  assert.deepEqual(perPerson, { amount: 1500, currency: 'USD', per_person: true, total: 3000 });
  const total = applyTripChanges({}, changes({ budget: { amount: 1500, currency: null, per_person: false } })).summary.budget;
  assert.deepEqual(total, { amount: 1500, currency: null, per_person: false, total: 1500 });
  const unknownBasis = applyTripChanges({}, changes({ budget: { amount: 1500, currency: 'EUR', per_person: null } })).summary.budget;
  assert.equal(unknownBasis.total, null);
});

test('extractor: Oct 4 to Oct 10 is 6 days (decision 7 keeps this counting in one place)', () => {
  assert.equal(durationFromDates('2026-10-04', '2026-10-10'), 6);
  const { summary } = applyTripChanges({ tripType: ['family'] },
    changes({ outbound_date: '2026-10-04', return_date: '2026-10-10', duration_days: 7 }));
  assert.equal(summary.duration_days, 6);
  assert.deepEqual(summary.tripType, ['family']);
  assert.equal(applyTripChanges({}, changes({ duration_days: 5 })).summary.duration_days, 5);
});

test('a new destination replaces the whole endpoint and reports the change', () => {
  const update = applyTripChanges({ destination: { city: 'Paris', iata: 'PAR' } },
    changes({ destination: { city: 'Rome', iata: null } }));
  assert.deepEqual(update.summary.destination, { city: 'Rome', iata: null });
  assert.equal(update.destinationChanged, true);
  assert.equal(applyTripChanges({}, changes({ destination: { city: 'Rome', iata: 'ROM' } })).destinationChanged, false);
});

test('impossible or reversed dates are not saved and become a limitation', () => {
  const impossible = applyTripChanges({}, changes({ outbound_date: '2026-02-30' }));
  assert.equal(impossible.summary.outbound_date, null);
  assert.equal(impossible.limitations.length, 1);
  const reversed = applyTripChanges({ outbound_date: '2026-12-12' }, changes({ return_date: '2026-12-01' }));
  assert.equal(reversed.summary.return_date, null);
  assert.equal(reversed.datesChanged, false);
  assert.match(reversed.limitations[0], /return date was before/);
});

test('out-of-scope preferences are never stored, and clear empties a field', () => {
  const { summary } = applyTripChanges({ budget: { amount: 900, currency: 'USD', per_person: false, total: 900 } },
    changes({ tripType: { add: ['hotel stays', 'food'], remove: [] }, clear: ['budget'] }));
  assert.deepEqual(summary.tripType, ['food']);
  assert.deepEqual(summary.budget, { amount: null, currency: null, per_person: null, total: null });
});

test('every merged summary passes the client schema', () => {
  const { summary } = applyTripChanges(CLIENT_EXAMPLE, changes({
    destination: { city: 'Cartagena', iata: 'ctg' },
    outbound_date: '2026-12-12',
    return_date: '2026-12-16',
    passengerData: passengers({ total: 4, adults: 2, children: 2, childrenAges: [6, 9] }),
    tripType: { add: ['family', 'warm weather'], remove: [] },
  }));
  assert.equal(validateClientSummary(summary).ok, true);
  assert.equal(summary.duration_days, 4);
  assert.equal(summary.origin.city, 'NEWDELHI');
});
