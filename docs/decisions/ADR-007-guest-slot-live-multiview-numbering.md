# ADR-007: Guest-slot live-multiview input numbering (stored slot number vs #463-compacted pad)

**Date**: 2026-10-15
**Status**: Proposed — pending decision by **@svensson00** (PM decision authority)

## Context

Studio allocates guest slots from the top of the mixer-input range down (`video_in_15`, `video_in_14`,
…). Issue #463 compacts these sparse stored pads to a contiguous `0..N-1` range for the live Strom
vision mixer and persists the mapping as `mixerInputMap` on the production document
(`src/lib/flow-generator.ts:455-494`, `src/lib/mixer-input-map.ts`), so the GPU multiview is sized to
exactly what the production uses and shows no empty tiles.

A consequence (issue #512): a guest slot stored as `video_in_5` — shown as **"Input 6"** in Studio
(1-indexed) — can compact to pad index 2 and so render as **"input 3"** in the live multiview. The
picture and the `Guest N` / invite label resolve to the correct compact tile; only the *displayed
number* differs from the Studio slot number the operator set.

Whether the live multiview should display the **stored Studio slot number** or the **compacted pad
number** is a product trade-off (user-facing consistency vs GPU-multiview cost) that reverses or relaxes
a shipped behaviour (#463). The agent team is not positioned to decide this unilaterally. The related
**label** defect ("Whip" instead of `Guest N` / invite name) is decided separately in
`docs/specs/guest-slot-input-numbering.md` and does not depend on this ADR.

## Decision

**Pending @svensson00.** No decision is recorded yet. One of:

- **A. Keep the #463 compaction** — the live multiview keeps showing the compacted pad number.
- **B. Show the stored Studio slot number** — size the mixer by the highest stored pad (revert #463) or
  carry the stored number into the overlay.
- **C. Keep compaction, surface the stored slot number in the overlay label** (e.g. `Guest 1 · In 6`).

## Consequences

**Positive**
- **A**: no empty tiles; preserves #463's GPU-multiview benefit and the #436 "guest picture always
  reaches the mixer" invariant; zero change.
- **B**: live multiview number matches Studio everywhere; fully resolves the reported confusion.
- **C**: keeps #463's benefit and shows the operator's slot number.

**Negative**
- **A**: multiview number stays out of sync with the Studio slot number (reported confusion unresolved).
- **B**: reintroduces empty tiles / larger GPU multiview (the problem #463 solved), or decouples displayed
  number from physical pad and needs a new Strom overlay convention.
- **C**: new label convention, longer overlay text, two numbers on screen.

**Risks**
- B/C are cross-service (change live Strom mixer sizing and/or the overlay convention across `open-live`
  and `open-live-studio`); detect regressions via the `openlivedev` beta regression gate and the
  guest-label test suite (`src/__tests__/flow-generator-guest-labels.test.ts`,
  `src/__tests__/mixer-input-map.test.ts`).

## Alternatives Considered

See options A/B/C above; this ADR exists precisely to carry the three until @svensson00 selects one.
On selection: set Status **Accepted** with the chosen option, or **Rejected** if Option A (status quo)
is chosen (no code change) — and update `docs/specs/guest-slot-input-numbering.md` accordingly.
