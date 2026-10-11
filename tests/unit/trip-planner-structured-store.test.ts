import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { TripPlannerManagerOutput } from '../../src/agents/trip-planner/manager-output.js';
import { getTripPlannerFormattingRules } from '../../src/agents/trip-planner/manager-output.js';
import { buildTripPlannerPlanningBrief } from '../../src/agents/trip-planner/context/planning-brief.js';
import { finalizeTripPlannerTurn } from '../../src/agents/trip-planner/context/lifecycle.js';
import { getTripPlannerContextDetails, setTripPlannerLastPlanArtifact } from '../../src/agents/trip-planner/context/store.js';

function context(): Record<string, any> {
  const value: Record<string, any> = {
    summaryContext: { destination: { city: 'Paris', iata: 'PAR' }, duration_days: 3 },
    tripPlanner: { contextRevision: 1, scopeClassification: { mode: 'in_scope' } },
  };
  value.tripPlanner.planningBrief = buildTripPlannerPlanningBrief({ summaryContext: value.summaryContext });
  return value;
}

function feedback(value: Record<string, any>, patch: Partial<TripPlannerManagerOutput> = {}): TripPlannerManagerOutput {
  return {
    status: 'success',
    mode: 'compact_full',
    destinationCards: [{
      itemCode: 'PAR', title: 'Paris, France', imageUrl: 'https://images.example.test/paris.jpg',
      knownFor: 'Art and food', weather: 'Best in spring', budget: 'Balanced cost tier',
    }],
    itineraryDays: [1, 2, 3].map((day) => ({
      day, title: `Theme ${day}`, morning: `Morning attraction ${day}`,
      afternoon: `Afternoon attraction ${day}`, evening: `Evening activity ${day}`,
    })),
    recommendation: 'A relaxed cultural plan',
    notes: [{ kind: 'fit', text: 'Balanced around the known interests', sourceName: null }],
    tables: [{
      kind: 'budget', title: 'Budget guidance', columns: ['Focus', 'Guidance'],
      rows: [{ cells: ['Food', 'Balanced'], recommended: false }],
    }],
    nextQuestions: [],
    formattingRules: getTripPlannerFormattingRules(value),
    limitations: [],
    ...patch,
  };
}

function patch(value: Record<string, any>, changes: Partial<TripPlannerManagerOutput> = {}): TripPlannerManagerOutput {
  return feedback(value, {
    mode: 'compact_patch', destinationCards: [], itineraryDays: [],
    recommendation: null, notes: [], tables: [], ...changes,
  });
}

describe('Trip Planner structured plan persistence', () => {
  it('persists factual feedback without user markdown or stale formatting policies', () => {
    const value = context();
    const result = feedback(value);
    const before = structuredClone(result);
    const saved = setTripPlannerLastPlanArtifact(value, { feedback: result })!;
    assert.deepEqual(saved.days.map((day) => day.day), [1, 2, 3]);
    assert.equal(saved.days[1].morning, 'Morning attraction 2');
    assert.equal(saved.destinationCards![0].imageUrl, result.destinationCards[0].imageUrl);
    assert.doesNotMatch(saved.content, /formattingRules|cardMarkdown|:::cards/);
    assert.equal('formattingRules' in saved, false);
    assert.deepEqual(result, before);
  });

  it('merges only changed time blocks and preserves unchanged days across later patches', () => {
    const value = context();
    const original = setTripPlannerLastPlanArtifact(value, { feedback: feedback(value) })!;
    const originalCopy = structuredClone(original);
    const updated = setTripPlannerLastPlanArtifact(value, { feedback: patch(value, {
      itineraryDays: [{ day: 2, title: null, morning: 'Easy cafe visit', afternoon: null, evening: null }],
    }) })!;
    assert.deepEqual(updated.days.map((day) => day.day), [1, 2, 3]);
    assert.equal(updated.days[1].title, 'Theme 2');
    assert.equal(updated.days[1].morning, 'Easy cafe visit');
    assert.equal(updated.days[1].afternoon, 'Afternoon attraction 2');
    assert.equal(updated.days[1].evening, 'Evening activity 2');
    assert.doesNotMatch(updated.content, /Morning attraction 2/);
    assert.deepEqual(original, originalCopy);
    setTripPlannerLastPlanArtifact(value, { feedback: patch(value, {
      itineraryDays: [{ day: 3, title: 'New theme', morning: null, afternoon: null, evening: 'A quiet evening' }],
    }) });
    const read = getTripPlannerContextDetails(value, { sections: ['last_plan'], query: 'day 2' });
    assert.equal(read.details.lastPlan.days[0].morning, 'Easy cafe visit');
    assert.equal(value.tripPlanner.lastPlanArtifact.days[2].morning, 'Morning attraction 3');
  });

  it('treats explicit free time as removal, never null as removal', () => {
    const value = context();
    setTripPlannerLastPlanArtifact(value, { feedback: feedback(value) });
    const saved = setTripPlannerLastPlanArtifact(value, { feedback: patch(value, {
      itineraryDays: [{ day: 1, title: null, morning: null, afternoon: 'Free time', evening: null }],
    }) })!;
    assert.equal(saved.days[0].afternoon, 'Free time');
    assert.doesNotMatch(saved.content, /Afternoon attraction 1/);
    assert.equal(saved.days[0].morning, 'Morning attraction 1');
  });

  it('retains cards, days, notes and tables for non-day patches and replaces supplied kinds', () => {
    const value = context();
    const full = feedback(value, { notes: [
      { kind: 'fit', text: 'Known interest fit', sourceName: null },
      { kind: 'change', text: 'Old change', sourceName: null },
    ] });
    setTripPlannerLastPlanArtifact(value, { feedback: full });
    const saved = setTripPlannerLastPlanArtifact(value, { feedback: patch(value, {
      notes: [{ kind: 'change', text: 'Keep more flexible time', sourceName: null }],
    }) })!;
    assert.equal(saved.days.length, 3);
    assert.deepEqual(saved.destinationCards, full.destinationCards);
    assert.deepEqual(saved.tables, full.tables);
    assert.deepEqual(saved.notes!.map((note) => note.text), ['Known interest fit', 'Keep more flexible time']);
    assert.doesNotMatch(saved.content, /Old change/);
    const budget = patch(value, { tables: [{
      kind: 'budget', title: 'Revised budget', columns: ['Focus', 'Guidance'],
      rows: [{ cells: ['Food', 'Value'], recommended: false }],
    }] });
    assert.equal(setTripPlannerLastPlanArtifact(value, { feedback: budget })!.tables!.length, 1);
  });

  it('replaces full plans and never merges a different destination', () => {
    const value = context();
    setTripPlannerLastPlanArtifact(value, { feedback: feedback(value) });
    const replacement = feedback(value, { itineraryDays: [{
      day: 1, title: 'Fresh plan', morning: 'New morning', afternoon: 'New afternoon', evening: 'New evening',
    }] });
    assert.equal(setTripPlannerLastPlanArtifact(value, { feedback: replacement })!.days.length, 1);
    value.summaryContext.destination = { city: 'Rome', iata: 'ROM' };
    const changed = setTripPlannerLastPlanArtifact(value, { feedback: patch(value, {
      itineraryDays: [{ day: 2, title: 'Rome day', morning: 'Roman sights', afternoon: null, evening: null }],
    }) })!;
    assert.deepEqual(changed.days.map((day) => day.day), [2]);
    assert.deepEqual(changed.destinationCards, []);
    assert.doesNotMatch(changed.content, /Fresh plan|New morning|Paris/);
  });

  it('keeps useful saved plans on failures, excluded requests, answers and empty feedback', () => {
    const value = context();
    const saved = setTripPlannerLastPlanArtifact(value, { feedback: feedback(value) });
    for (const changes of [
      { status: 'failure' as const }, { status: 'needs_input' as const }, { mode: 'answer' as const },
      { itineraryDays: [], destinationCards: [] },
    ]) {
      assert.equal(setTripPlannerLastPlanArtifact(value, { feedback: feedback(value, changes) }), null);
      assert.equal(value.tripPlanner.lastPlanArtifact, saved);
    }
    value.tripPlanner.scopeClassification.mode = 'excluded';
    assert.equal(setTripPlannerLastPlanArtifact(value, { feedback: feedback(value) }), null);
    assert.equal(value.tripPlanner.lastPlanArtifact, saved);
    const finalized = finalizeTripPlannerTurn({ context: value, feedback: feedback(value), storePlanArtifact: false });
    assert.equal(finalized.lastPlanArtifact, null);
    assert.equal(value.tripPlanner.lastPlanArtifact, saved);
  });

  it('recovers legacy labelled blocks on reload while preserving unknown legacy prose', () => {
    const value = context();
    setTripPlannerLastPlanArtifact(value, {
      output: '**Day 1 - Art**\n🌅 **Morning:** **Louvre Museum**.\n☀️ **Afternoon:** Riverside walk.\n🌙 **Evening:** Food district.\n**Day 2 - Flexible**\nKeep the unstructured old guidance.',
      responseMode: 'compact_full',
    });
    const reloaded = JSON.parse(JSON.stringify(value));
    const updated = setTripPlannerLastPlanArtifact(reloaded, { feedback: patch(reloaded, {
      itineraryDays: [
        { day: 1, title: null, morning: null, afternoon: 'Free time', evening: null },
        { day: 2, title: null, morning: 'A cafe stop', afternoon: null, evening: null },
      ],
    }) })!;
    assert.equal(updated.days[0].morning, 'Louvre Museum.');
    assert.equal(updated.days[0].afternoon, 'Free time');
    assert.equal(updated.days[0].evening, 'Food district.');
    assert.doesNotMatch(updated.content, /Riverside walk/);
    assert.equal(updated.days[1].legacyContent, 'Keep the unstructured old guidance.');
    assert.equal(updated.days[1].morning, 'A cafe stop');
    assert.equal(updated.days[1].afternoon, null);
    assert.match(updated.content, /Keep the unstructured old guidance/);
  });

  it('filters saved records and typed day blocks before the ten-item limit', () => {
    const value = context();
    value.summaryContext.placesOfInterest = Array.from({ length: 15 }, (_, index) => ({ placeName: `Saved place ${index + 1}`, description: 'Saved detail' }));
    const full = feedback(value, { itineraryDays: Array.from({ length: 15 }, (_, index) => ({
      day: index + 1, title: `Day theme ${index + 1}`, morning: `Saved morning ${index + 1}`, afternoon: 'Free time', evening: 'Food district',
    })) });
    setTripPlannerLastPlanArtifact(value, { feedback: full });
    const day = getTripPlannerContextDetails(value, { sections: ['last_plan'], query: 'day 15', limit: 1 });
    assert.equal(day.details.lastPlan.days[0].morning, 'Saved morning 15');
    assert.equal(day.details.lastPlan.destinationCards[0].imageUrl, full.destinationCards[0].imageUrl);
    assert.equal('formattingRules' in day.details.lastPlan, false);
    const place = getTripPlannerContextDetails(value, { sections: ['places'], query: 'Saved place 15', limit: 1 });
    assert.equal(place.details.places[0].placeName, 'Saved place 15');
  });

  it('preserves a legacy itinerary with no recognizable day headings', () => {
    const value = context();
    setTripPlannerLastPlanArtifact(value, { output: 'Saved unstructured guidance that has no day headings.', responseMode: 'compact_full' });
    const saved = setTripPlannerLastPlanArtifact(value, { feedback: patch(value, {
      itineraryDays: [{ day: 2, title: null, morning: 'An explicit morning replacement', afternoon: null, evening: null }],
    }) })!;
    assert.equal(saved.legacyContent, 'Saved unstructured guidance that has no day headings.');
    assert.equal(saved.days[0].morning, 'An explicit morning replacement');
    assert.equal(saved.days[0].afternoon, null);
    const read = getTripPlannerContextDetails(value, { sections: ['last_plan'] });
    assert.equal(read.details.lastPlan.legacyContent, saved.legacyContent);
  });

  it('records typed question keys and shared canonical aliases, not incidental fact text', () => {
    const value = context();
    value.tripPlanner.askedQuestionKeys = ['interests'];
    finalizeTripPlannerTurn({ context: value, feedback: feedback(value, {
      recommendation: 'A budget-friendly plan; party and dates are already known',
      nextQuestions: [
        { key: 'travel_dates_or_duration', purpose: 'Confirm timing' },
        { key: 'traveler_count', purpose: 'Confirm traveler count' },
      ],
    }) });
    assert.deepEqual(new Set(value.tripPlanner.askedQuestionKeys), new Set([
      'interests', 'travel_dates_or_duration', 'dates', 'duration', 'traveler_count', 'party',
    ]));
    assert.equal(value.tripPlanner.askedQuestionKeys.includes('budget'), false);
  });

  it('preserves standalone string storage and bounds compatibility text', () => {
    const value = context();
    const saved = setTripPlannerLastPlanArtifact(value, { output: 'A standalone text plan.', responseMode: 'compact_full' });
    assert.equal(saved!.content, 'A standalone text plan.');
    const bounded = setTripPlannerLastPlanArtifact(value, { feedback: feedback(value, {
      recommendation: 'A'.repeat(20_000),
      itineraryDays: [{ day: 1, title: 'B'.repeat(200), morning: 'C'.repeat(2_000), afternoon: null, evening: null }],
    }) })!;
    assert.ok(bounded.content.length <= 12_000);
    assert.ok(bounded.days[0].content.length <= 700);
    assert.ok(bounded.days[0].title.length <= 100);
    assert.ok(bounded.days[0].morning!.length <= 700);
  });
});
