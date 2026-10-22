# Place marks in replies: what the client renders

For the team building the production chat client. Since 22 October 2026, assistant replies name places with **place marks**, which the backend adds after the reply is written. This guide covers what arrives, how to render it, and what to do when you don't support it yet. The shared module `public/shared/reply.js` (`renderReply`, `createPhotoPeek`), which the chat dashboard and the test-runs viewer both use, is the reference implementation.

## What the reply contains

The reply text is Markdown. The first mention of each place a specialist named is a link with a `place:` reference:

```markdown
**Day 1 · Old Tokyo:** [Sensō-ji](place:2) early, snacks along [Nakamise-dōri](place:3), then [Tokyo Skytree](place:4).
```

The `done` event carries the marks in reply order:

```json
"places": [
  { "ref": "1", "kind": "city", "photo": "https://upload.wikimedia.org/.../960px-....jpg" },
  { "ref": "2", "kind": "temple", "photo": null },
  { "ref": "3", "kind": "market", "photo": null },
  { "ref": "4", "kind": "landmark", "photo": null }
]
```

- `ref` matches the number in `place:N`, starting at 1, in the order the marks appear.
- The place's name is the link text. The list doesn't repeat it.
- `photo` is a URL or `null`. Today only cities have photos.
- The chat keeps the list with the message, as `messages[].places` in the chat returned on reload. Replies saved before 22 October have none.
- A reply never contains any other link. The backend removes links the model writes, and its final check lets only the marks it issued through.

## The kinds

Every mark has one of twelve kinds. Eleven are places, tagged by the Trip specialist. `flight` marks the first "flight" or "flights" in a reply on a turn that searched or showed flights.

| Kind | Meaning |
|---|---|
| `city` | A city or destination, including a flight route's cities |
| `area` | A neighborhood or town |
| `landmark` | A sight, tower or viewpoint |
| `temple` | A temple, shrine, church or mosque |
| `museum` | A museum or other culture venue |
| `park` | A park or garden |
| `nature` | A beach, lake, waterfall, mountain or river |
| `market` | A market or shopping street |
| `food` | A food street, hall or restaurant |
| `nightlife` | Nightlife |
| `daytrip` | A place visited for the day |
| `flight` | The flights the reply is about |

Treat an unknown kind as a client without support would (see below), so new kinds never break the client.

## Rendering

- **Icon before the name.** Draw the kind's icon inline before the link text, at the text's size (about 0.95 em), in the accent color. Keep the name's own weight; the reference makes marks semi-bold.
- **Photo dot.** When `photo` is set, add a small dot on the icon's top-right corner and make the mark a button. On desktop, hover or click opens a popover with the photo and the name. Load the image only when the popover first opens. The reference uses a 260 px wide popover with a 4:3 image. Phones are not designed yet: the desktop popover comes first.
- **No photo.** A plain inline mark with the icon and a tooltip naming the kind. It isn't clickable.
- **Accessibility.** Hide the icon from screen readers (`aria-hidden`). A mark with a photo gets a label such as "Sensō-ji, temple, photo" and `aria-haspopup="dialog"`.
- **Line breaks.** Replies use single line breaks between lines of a list and between paragraphs. Render them as a chat app does (GFM with `breaks`), or lines run together.

### Sanitizing

If your Markdown renderer strips unknown link schemes, allow exactly `place:` followed by digits for links, and nothing else new. Resolve each `place:N` against `places` before rendering, and never fetch anything from the reference itself.

### Without support

A client that doesn't support marks yet should show the link text as plain text. In React Markdown, that means a custom link component that returns its children for `place:` links. The reply reads correctly either way, because the marks only decorate names already in the sentence.

## The icons

The reference icons are 16 × 16 line icons with `fill: none`, `stroke: currentColor`, `stroke-width: 1.4` and round caps and joins. You can draw your own; only the twelve kind names are the contract.

```html
<symbol id="pk-city" viewBox="0 0 16 16"><path d="M2 14h12M3.5 14V7.5h3V14M6.5 14V3.5h4V14M10.5 14V9h2v5"/></symbol>
<symbol id="pk-area" viewBox="0 0 16 16"><path d="M8 14.2s-4.3-4.4-4.3-7.7a4.3 4.3 0 1 1 8.6 0c0 3.3-4.3 7.7-4.3 7.7z"/><circle cx="8" cy="6.4" r="1.5"/></symbol>
<symbol id="pk-landmark" viewBox="0 0 16 16"><path d="M8 1.6v2.4M6.4 14.4 8 4l1.6 10.4M5.6 9.6h4.8M6.2 6.8h3.6M4.5 14.4h7"/></symbol>
<symbol id="pk-temple" viewBox="0 0 16 16"><path d="M8 1.5v1.6M3 6.2c1.6-.5 3.4-1.9 5-3.1 1.6 1.2 3.4 2.6 5 3.1M4.6 6.2v3M11.4 6.2v3M2.4 9.6c2 0 3.8-.9 5.6-2 1.8 1.1 3.6 2 5.6 2M5 9.6v4.6M11 9.6v4.6M3 14.2h10"/></symbol>
<symbol id="pk-museum" viewBox="0 0 16 16"><path d="M2.2 5.6 8 2.4l5.8 3.2zM3.2 6.5h9.6M4.4 6.5v6M7 6.5v6M9 6.5v6M11.6 6.5v6M2.4 13.6h11.2"/></symbol>
<symbol id="pk-park" viewBox="0 0 16 16"><path d="M8 14.4V9.8M5.4 14.4h5.2M8 9.8c-2.7 0-4.3-1.6-4.3-3.6 0-1.4.9-2.4 1.9-2.7C5.9 2.3 6.9 1.6 8 1.6s2.1.7 2.4 1.9c1 .3 1.9 1.3 1.9 2.7 0 2-1.6 3.6-4.3 3.6z"/></symbol>
<symbol id="pk-nature" viewBox="0 0 16 16"><path d="M1.6 12.2 5.6 4.8l2.6 4.2 1.6-2.4 4.6 5.6zM1.6 14.6c1.3-.9 2.6-.9 3.9 0s2.6.9 3.9 0 2.6-.9 3.9 0"/></symbol>
<symbol id="pk-market" viewBox="0 0 16 16"><path d="M3.2 5.6h9.6l-.9 8.6H4.1zM5.8 5.6V4.4a2.2 2.2 0 0 1 4.4 0v1.2"/></symbol>
<symbol id="pk-food" viewBox="0 0 16 16"><path d="M4.6 1.8v4.4M3 1.8v3.4a1.6 1.6 0 0 0 3.2 0V1.8M4.6 6.8v7.4M11.6 14.2V1.8c-1.7.7-2.6 2.6-2.6 4.8v3h2.6"/></symbol>
<symbol id="pk-nightlife" viewBox="0 0 16 16"><path d="M3 2.4h10L8 8.6zM8 8.6v5.2M5.4 13.8h5.2M4.6 4.2h6.8"/></symbol>
<symbol id="pk-daytrip" viewBox="0 0 16 16"><circle cx="3.8" cy="12.2" r="1.6"/><circle cx="12.2" cy="3.8" r="1.6"/><path d="M5.2 11.3c2.3-.6 1.4-3.6 3.6-4.6 1.2-.5 1.8-1.1 2.1-1.6" stroke-dasharray="1.6 1.6"/></symbol>
<symbol id="pk-flight" viewBox="0 0 16 16"><path d="M14.6 8c0-.5-.7-.9-1.6-.9H9.8L6.6 2.4H5.2l1.6 4.7H3.6L2.4 5.2h-1L2 8l-.6 2.8h1l1.2-1.9h3.2l-1.6 4.7h1.4l3.2-4.7H13c.9 0 1.6-.4 1.6-.9z"/></symbol>
```

## The acknowledgement and the chips

Two more pieces of a turn the client shows:

- **The acknowledgement.** When the specialists run, the stream sends one `acknowledgement` event before `done`, as soon as the work starts:

  ```
  event: acknowledgement
  data: {"chatId":"…","turnId":"…","text":"Putting together a 5-day solo Tokyo itinerary and checking what flight details are needed."}
  ```

  Show it while the turn runs, as a muted line where the reply will appear, and keep it above the reply once `done` arrives. The reply never repeats it. It is one sentence of 11 to 21 words with no emojis. The chat also saves it with the message as `messages[].acknowledgement`. A turn the Manager answers alone, such as small talk or a day zoom, has none.
- **The chips.** `done.summary.suggestedQuestions` holds up to four short follow-ups. Show them as buttons under the latest reply; a tap sends the chip's words as the traveler's next message and clears the row. After a plan, one chip usually zooms in, such as "Day 4 in detail".

The chat dashboard (`public/chat-dashboard/app.js`) shows both, and it renders replies with the same shared module as the test-runs viewer: `public/shared/reply.js` and `public/shared/reply.css`.

## What else changed in replies

These need no client work, but explain what testers will see:

- **No emojis or icons from the model.** The only icons in the chat are the marks above.
- **An opening line.** A reply with results starts with one sentence saying what was done for the traveler and why it suits them, such as "Here's a balanced 5-day solo Tokyo plan that clusters neighborhoods so you're not crisscrossing the city every day." Lists and day labels come after it.
- **No headings.** Bold is used only for a label that starts a line, such as "**Day 1 · Old Tokyo:**".
- **Shorter replies, sized to the request.** Word limits:

  | Reply | Words |
  |---|---|
  | A glance at a destination | up to 120 |
  | Destination options | up to 130 |
  | A plan, one line per day | up to 200 |
  | One day in detail | up to 160 |
  | A change | up to 80 |
  | An answer | up to 100 |
  | Flight results | up to 50, plus the price note |

  A traveler sees more by asking, such as "Day 4 in detail". Trip suggests such a chip after a plan, and the Manager answers it from the plan already shown, without another specialist call.
- **The acknowledgement** shown while the specialists work is one sentence of 11 to 21 words, and the reply never repeats it.
- **One question at most.** When the flight search still needs a detail, such as where the traveler is flying from, that detail is the question.
