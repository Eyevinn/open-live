# ADR-007: Guest-slot live-multiview input numbering (stored slot number vs #463-compacted pad)

**Date**: 2026-10-15
**Status**: Accepted — Option C (guest tiles only), decided by **@svensson00** (PM decision authority) on 2026-10-15

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

**Option C, for guest tiles only** — decided by @svensson00 on 2026-10-15 (on #517).

- The **#463 empty-tile compaction is kept unchanged.** No empty tiles was the point of that change, so
  the live Strom vision mixer stays sized to exactly the compacted `0..N-1` range and `mixerInputMap` is
  unchanged.
- For **guest tiles only**, the stored **Studio slot number** is surfaced in the tile label — e.g.
  `Guest 1 · In 6`, or the invite name in place of `Guest 1` once the guest has joined (e.g. `Ada · In 6`).
  `In 6` is the 1-indexed stored Studio slot number the operator set, carried into the overlay label text;
  the physical pad badge stays the compacted number.
- **Sources (non-guest tiles) are unchanged.** Sources already number identically in Studio and the
  multiview, so no label suffix is added to them — only guest tiles diverge and so only guest tiles need it.
- The **label fix** (a guest tile must always resolve to `Guest N` / invite name and must **never** leak
  the raw virtual-source id `Whip` or generic name `WHIP Input`) is **independent of this decision and
  ships first**, as proposed in the spec. This slot-number-in-label work follows it.

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

- **A. Keep the #463 compaction, show only the compacted pad number — NOT chosen.** The live multiview
  number stays out of sync with the Studio slot number the operator set, so the reported confusion is
  left unresolved (only the label would be fixed).
- **B. Show the stored Studio slot number as the pad number — NOT chosen.** Sizing the mixer by the
  highest stored pad reintroduces empty tiles and a larger GPU multiview — "no empty tiles was the point
  of #463" (@svensson00), so reverting or relaxing the compaction was explicitly rejected. The
  carry-the-number variant would also need a new Strom overlay convention decoupling the displayed
  number from the physical pad.
- **C. Keep compaction, surface the stored slot number in the guest-tile label — CHOSEN** (guest tiles
  only; e.g. `Guest 1 · In 6`). Keeps #463's GPU-multiview benefit and the #436 "guest picture always
  reaches the mixer" invariant *and* shows the operator's slot number, with the smallest physical change
  and no change to sources.

Decided by @svensson00 on 2026-10-15 (recorded on #517): "Option C, for guest tiles only. Keep the #463
compaction: no empty tiles was the point of that change. Sources are already numbered the same in Studio
and the multiview, so only guest tiles need it." The spec
(`docs/specs/guest-slot-input-numbering.md`) is updated to mark the open product question Resolved —
Option C.
