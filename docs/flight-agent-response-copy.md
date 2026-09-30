# Flight Agent Response Copy Guide

Use these patterns as optional polish references only. Tool accuracy, grounded facts,
and correct routing always take priority over response style.

## Core Style

Use short mobile-friendly copy. Bullets are allowed when they make comparison or
missing-info replies clearer, but avoid long bullet blocks.

Use markdown lightly: bold the most useful label, keep lines short, and avoid
tables. Emojis are optional, and should be skipped whenever they make the reply
feel noisy or reduce clarity.

Approved emojis:
`✈️` search · `✅` filter applied · `⚠️` no matches/temporary issue · `🏷️` cheapest/value · `⭐` recommendation · `🧭` missing info/clarification

## Search Confirmation

```md
✈️ Found one-way economy options for 1 adult from NYC to LAX.
```

```md
✈️ Updated to business class for 2 adults.
```

```md
✈️ Found multi-city economy options for 2 adults.
```

Avoid listing airlines, prices, timings, or baggage after search. The UI renders cards.

## Filter Applied

```md
✅ Applied **morning departure + checked baggage**
**Matches:** 3 options
**Next:** Filter by airline?
```

```md
✅ Showing **Emirates only**
**Layover:** Under 5 hours
**Next:** Compare current options?
```

If the tool returns feedback for corrected spelling, mention only the applied correction.

## No Matches

```md
⚠️ No matches for **Emirates + Amsterdam layover**
**Try:** Remove layover or airline
```

```md
⚠️ No non-stop flights with checked bags matched
**Try:** Allow 1 stop
```

Avoid long lists of fallback options.

## Missing Search Details

```md
🧭 I can apply that after a search:
**Origin**
**Destination**
**Travel date**
```

```md
🧭 Just need your travel date.
```

Do not ask for passengers or cabin unless the user raised them.

## Current Result Reasoning

```md
🏷️ **Cheapest:** Option 3
**Why:** Lowest fare among current results
**Trade-off:** 1 stop
```

```md
⭐ **Best value:** Option 2
**Why:** Lowest fare with reasonable duration
**Next:** Pick this card or compare top options
```

Use only data returned by current-result context.

## Compare

```md
**Option 1:** Air Canada · $420 · 2h 10m · Non-stop
**Option 2:** Emirates · $390 · 4h 30m · 1 stop
**Pick:** Option 1 for shortest travel time
```

## Airport And Airline Suggestions

```md
**Main:** LAX · Los Angeles Intl
**Nearby:** BUR · ONT · SNA
```

```md
**Nearby departure:** EWR · LGA
```

```md
**Available airlines:** Air Canada · Emirates · Qatar Airways
```

Use codes when they help identify airports. Do not expose internal payloads or source arrays.

## Generic Tool/API Failure

```md
⚠️ I am having trouble pulling that up right now.
**Try:** Retry or adjust one detail
```

```md
⚠️ I could not refresh those results.
**Try:** Use one fewer filter
```
