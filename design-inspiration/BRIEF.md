# Orbyt design brief, from 57 Framer SaaS / AI / software templates

Sources: `notes/*.md` (one per template), screenshots in `shots/<slug>/{desktop,mobile}.png`. Counts below are how many of the 57 notes mention a pattern. These are patterns in our own words; no template's wording, brand, imagery or exact layout is reused.

## What the 57 have in common (so we know what is generic)
- **Numbered "how it works" steps:** 28. The single most common section.
- **Bento feature grids:** 16. **Logo marquee / trust strip:** 15. **Mono uppercase eyebrows:** 15.
- **Pricing:** only 6, almost always three tiers with the middle one highlighted.
- **Dark mode:** 14 of 57. Most are light, with one gradient or one accent hue.
- **Notes flag the same faults again and again:** tiny or low-contrast grey/mono text (22), sections that did not render or are empty (20, partly capture limits), floating promo chips over content (12), placeholder or broken logo strips (9).

Reading: the field is gradient + bento + stock photo + placeholder logos. That is the look Orbyt should not drift towards. Our timetable world (ink, paper, one red, condensed type, ruled tables) is already more distinct than almost all of them.

## Keep: Orbyt's world stays
Ink sign fields, cool paper, signal red only for marker / main action / selection, condensed Archivo, tabular numerals, hairline rules, departure board. Do not add gradients, glass, 3D, halftone, or a second accent hue.

## Borrow (pattern only), ranked by fit
1. **Product as proof, not decoration.** A live-looking console or table beats a mood image: automation-studio (agent list + activity feed + stat tiles), cyber-security (findings table with status pills and time stamps), fieldnote (timestamped event timeline), vantage-control (dark console table). Fits our board; use real product surfaces on feature pages.
2. **Ruled editorial sections with a narrow label gutter:** inkling-waitlist, vantage-control. Number or label sits in a left gutter, heading and body on the right, hairline between. Matches our rules; use for feature sections instead of cards.
3. **Two-panel "what you see in the log / what the customer gets":** amanat-template. Good for the AI reply story (event log beside the drafted reply).
4. **Comparison where one column is inverted:** anvill; and "by hand vs automated" cards with a time footer: automationpro. Only with claims we can back (no invented competitor numbers).
5. **Pricing:** three tiers, middle highlighted, monthly/annual toggle (volchat, neuron-pro, pretty, lanx). Ours should be a timetable-style table, highlight the recommended tier with the signal marker, and use real plan names and limits from the product.
6. **Interactive sample:** ternfold (workflow studio sample), kiln-focus (live timer), tender-service (configurator). Our equivalent is a small working workflow or sequence preview, built only if cheap.
7. **One italic or serif accent word in a headline:** 7 templates. We already use condensed weight contrast; skip.
8. **Sticky nav with numbered steps beside a changing panel:** avenai, fantom, kova-agent. Possible for the "one line" section; lower priority.

## Avoid
- Placeholder logo strips, invented testimonials, five-star walls, unsourced stats (PRODUCT.md forbids invented evidence).
- Floating chips and promo badges over content; hatched or halftone decoration; 3D cubes; stock faces.
- Tiny mono or grey-on-grey text. Minimum 12px, body 16px, contrast AA.
- Sections that only exist after scroll animation (lazy-reveal gaps were the top capture problem; a real user on a slow device sees the same).

## Capture caveats (honest limits)
- Full pages are cut at 15,000px. Several templates captured with blank lazy-loaded sections (e.g. bezor, cinder, saro, dazura, weir, agentra, fieldnote); notes for those describe only what rendered.
- Mobile strip 1 only was reviewed for most templates. taskible's mobile was not reviewed.
- Scope was SaaS / AI / software categories (57 templates), not the whole marketplace (thousands).

## Site plan this implies (Orbyt public site)
Existing: `/` landing, `/sign-in`, `/sign-up`.
To build, in this order:
1. Shared marketing chrome (header, footer) extracted from the landing so every public page matches.
2. `/pricing`: plans as a timetable table, from the real plan data.
3. `/features`: one ruled section per service (CRM, cold email, inbox, workflows, forms and chat, AI, agencies, self-hosting), each with a real product surface.
4. `/self-host`: install steps, honest "builds from source" note.
5. `/changelog` or `/docs` link only if the repo has content for it; otherwise skip.
Then restyle the remaining app pages (Settings, Sequences, Mailboxes, Inbox, Deals, Tasks, workflow editor) through the same primitives.

## Brand decisions made from this research (public guide: /brand)
- **Idea:** "A timetable for outbound." Kept from the existing world; the field of 57 is gradient + bento, so a station-signage brand is the gap.
- **Mark:** an orbit opened 60° at one o'clock with the red departure dot riding in the gap (ring + dot alone looked like a stock icon; a wide gap looked like a loading spinner). Files: `apps/web/public/brand/*.svg`, favicon `apps/web/src/app/icon.svg`, component `components/brand.tsx`.
- **Platform number tile** (square ink tile with a number): from the numbered-gutter sections in inkling-waitlist, vantage-control, cinder and the 28 "numbered steps" templates, made square and ink to fit signage.
- **Time stamp** (amber 24h time on ink): from fieldnote's event timeline, bezor's live ticker and aurelo-saving's price ticker; ours is the real clock on the departure board.
- **State tile with a word:** from cyber-security's findings table and vantage-control's status pills; colour never alone.
- **Voice:** from PRODUCT.md (no invented evidence) plus the notes' repeated complaint about hype copy and placeholder proof.
- **Deliberately not taken:** gradients, glass, 3D, halftone, italic-serif accent word, stock faces, logo marquees.
