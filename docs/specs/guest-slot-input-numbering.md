# Spec: Guest-slot live-multiview input numbering & label

**Status**: Draft — Phase 1 (architect), per `epic-workflow.md`
**Issue**: Eyevinn/open-live#512 (`Refs #512`)
**Services**: `open-live` (backend flow generator + controller WS), `open-live-studio` (multiview rendering)
**Related**: #458 (multiviewer "In 5"/"In 6"), #460, #463 (empty-tile compaction), #464/#494 (audio strip labels), #466/#493 (live label/picture), #479

> This is a cross-service item and carries a **product decision that this team is NOT positioned to
> make unilaterally** (see [Open product question](#open-product-question-requires-svensson00)). The
> architect proposes a decided fix for the clearly-wrong label behaviour and lays out — but does not
> resolve — the numbering decision, which is flagged for **@svensson00** (PM decision authority).

---

## Problem statement

A customer (prod-se cluster, reported 2026-10-14, seen several times) places a guest in a Studio
guest slot shown as **Input 6**, the guest joins through guest calling, and the guest then appears in
the **live multiviewer as "input 3" with the label "Whip"** — neither the slot number nor the slot's
label the operator set in Studio. Two distinct wrongnesses are compounded:

1. **Number mismatch** — the live multiview tile is numbered *input 3*, not the Studio slot's *Input 6*.
2. **Label mismatch** — the tile reads the raw virtual-source id **`Whip`**, not the slot's
   `Guest N` / invite name.

A prior backend implementation attempt (issue #512, impl-failed comment, reproduced on `main`
`339a621`) confirmed the backend already assigns the guest-calling publisher to its Studio guest slot
and labels that tile `Guest N` / the invite name — so this is not a straight backend defect as framed.
The two wrongnesses have different root causes, and one of them requires a product decision.

---

## Root-cause analysis (grounded in source)

### A. The number (`input 3` not `Input 6`): the #463 empty-tile compaction

Studio allocates guest slots from the **top** of the mixer-input range downward
(`video_in_15`, `video_in_14`, …). Sizing the live Strom vision mixer by the highest stored pad would
leave a long run of empty tiles, so #463 **compacts** the sparse stored pads to a contiguous `0..N-1`
range and persists the mapping on the production document as `mixerInputMap` (stored `mixerInput` →
compact Strom pad index).

- Compaction is built in `src/lib/flow-generator.ts:455-494`: pads are ordered by the **numeric** stored
  index ascending and renumbered to a dense `0..N-1` index (`mixerInputMap`), and the mixer is sized to
  exactly `Object.keys(mixerInputMap).length` inputs (`numSourceInputs`, line 494).
- The stored↔compact helpers live in `src/lib/mixer-input-map.ts` (`storedPadIndex`,
  `mixerInputToStromPad`, `storedPadToStromPad`, `expandToStoredPadIndex`); the WS boundary applies them
  so the controller keeps indexing by the **stored** pad (`src/ws/controller.ts`).
- Worked example matching the report: a guest slot stored as `video_in_5` is "Input 6" in Studio
  (Studio displays the pad 1-indexed). If the production's assigned pads compact such that `video_in_5`
  maps to compact pad index **2**, the Strom vision mixer renders that tile as the 3rd input — **"input 3"
  1-indexed**. The WHIP endpoint id is derived from the same compact pad (`whip-${padIndex}-…`,
  `flow-generator.ts:833`), so video and label resolve to the correct **compact** tile — the picture is
  right, only the *displayed number* differs from the Studio slot.

The background is also recorded in `docs/repo-patterns.md:224-250`.

**Conclusion:** the `input 3` number is the **#463-compacted pad number**, working exactly as designed.
Whether the live multiview *should* instead show the stored Studio slot number (`Input 6`) is the open
product question below — it is a deliberate trade-off, not a bug.

### B. The label (`Whip` not `Guest N` / invite name): raw virtual-source id leak

The virtual WHIP source is registered as key **`'Whip'`** with display name **`'WHIP Input'`**
(`src/lib/audio-channels.ts:6`). Note the exact string the customer sees — **`Whip`** (capital W only) —
is the **source *id* key**, not the display name `WHIP Input` and not the Strom default `In N`.

The backend build-time labeller already does the right thing: for a WHIP guest slot (an assignment
carrying a `returnFeed` whose resolved source is `streamType === 'whip'`) it writes
`input_{padIndex}_label = "Guest N"` at the compact pad (`src/lib/flow-generator.ts:535-553`), with the
`Guest N` numbering from the shared `guestSlotNumber` map (`flow-generator.ts:511-517`, mirrored for
live updates in `src/lib/guest-slot-label.ts:56-65`). Once a guest joins, the invite name is pushed
live onto that pad (`applyGuestSlotMixerLabel`, `src/lib/guest-slot-label.ts:128-146`). The Strom-rendered
multiview overlay therefore emits `Guest N` / the invite name — **never the literal `Whip`**.

The one place that resolves a guest slot to the raw id **`Whip`** is a client-side fallback. In
`open-live-studio`, `TransitionPanel` builds each tile's name and, for a *non-return-feed* assignment,
falls back to the raw assignment sourceId:

```
name = realSource?.name ?? VIRTUAL_SOURCE_NAMES[a.sourceId] ?? a.sourceId
```
(`src/pages/ControllerPage/TransitionPanel.tsx:197`). For a slot whose `sourceId` is `Whip` and whose
`returnFeed` is **not** present in the production document as Studio sees it, this yields exactly the
displayed string **`Whip`**. The return-feed branch immediately above (`TransitionPanel.tsx:185-196`)
resolves correctly to the invite label or `Guest N` and explicitly avoids the raw id (studio#171) — so
the leak is specifically the *non-return-feed / unresolved-slot* path.

**Conclusion:** the literal `Whip` is a **raw virtual-source-id leak in `open-live-studio`'s tile naming**
(`TransitionPanel.tsx:197`, and any sibling renderer that shares the `?? sourceId` fallback). This part
is clearly wrong and is the **decided fix** below. (Whether this also manifests on the Strom WHEP
multiview the operator watches via `PgmPreview`/`PanePage` depends on the ops pre-check — a stale
pre-#460/#479 build could emit a non-`Guest N` overlay; current `main` does not.)

---

## Decided fix (no product decision required)

**A guest-slot tile label must always resolve to the slot's `Guest N` / invite name and must never fall
back to the raw virtual-source id (`Whip`) or generic name (`WHIP Input`).**

- `open-live-studio`: remove the raw-`sourceId` fallback for guest slots in the tile-naming path
  (`TransitionPanel.tsx:197`) and any sibling renderer. A slot that is a guest slot (recognised the same
  way the backend and the return-feed branch at `TransitionPanel.tsx:185-196` recognise it — an
  assignment carrying `returnFeed`, or sourceId `Whip`) must render the invite label when joined, else
  `Guest N`. If a production-document shape is reaching the client without `returnFeed` on a slot that
  is in fact a guest slot, that upstream shape must be corrected so the return-feed branch is taken.
- `open-live`: no change required for the label — the build-time + live labelling at
  `flow-generator.ts:535-553` and `guest-slot-label.ts:128-146` already emit `Guest N` / invite name and
  are the source of truth. The backend remains authoritative; the frontend must consume that identity
  rather than re-deriving a name from the raw id.

This is consistent with the established pattern in `docs/repo-patterns.md:224-250` and the controller's
own return-feed naming — it simply closes the one fallback that still exposes the id.

---

## Open product question (requires @svensson00)

> **Should the live multiviewer show the stored Studio slot number (Input 6), or the #463-compacted pad
> number (input 3)?**

This is the core question and the team is **not** positioned to decide it unilaterally — it trades a
user-facing number against a GPU-multiview cost and reverses/relaxes a shipped behaviour (#463).
@svensson00 to decide. Options and consequences:

| Option | What changes | Positive | Negative / cost |
|--------|--------------|----------|-----------------|
| **A. Keep compaction (status quo)** | Nothing; live multiview keeps showing the compacted number (`input 3`). | No empty tiles; mixer sized to exactly what the production uses; preserves #436 "guest picture always reaches the mixer" invariant and #463's benefit. | The multiview number stays out of sync with the Studio slot number the operator set — the reported confusion is *not* fixed (only the label is). |
| **B. Show the stored slot number** | Size the mixer by the highest stored pad (revert #463's compaction) **or** carry the stored pad number into the overlay so the displayed number matches Studio. | Live multiview number matches Studio ("Input 6" everywhere); eliminates the reported confusion entirely. | Reverting compaction reintroduces empty tiles and a larger GPU multiview (the exact problem #463 solved); the carry-the-number variant decouples the displayed number from the physical pad and needs a new Strom overlay convention. |
| **C. Keep compaction, surface the slot number in the label** | Physical pad stays compacted; the overlay label carries both, e.g. `Guest 1 · In 6`. | Keeps #463's GPU benefit *and* shows the operator's slot number; smallest physical change. | New label convention; longer overlay text; two numbers on screen (`input 3` pad badge + `In 6` in label) could itself read as inconsistent. |

Dependency note: the **decided label fix is independent** of this decision and can ship first. This
question only governs the *number*.

If @svensson00 selects **B** or **C**, that is a significant cross-service design choice (it changes the
live Strom mixer sizing and/or the overlay label convention and spans both services) and is recorded as
**ADR-007** (`docs/decisions/ADR-007-guest-slot-live-multiview-numbering.md`, Status **Proposed /
pending @svensson00**). Option **A** needs no ADR beyond marking ADR-007 Rejected.

---

## Service interactions

```mermaid
sequenceDiagram
    participant Studio as open-live-studio (Setup)
    participant OL as open-live (backend)
    participant Flow as flow-generator.ts
    participant Strom as Strom vision mixer
    participant MV as Live multiview (WHEP) / Studio tiles

    Studio->>OL: Create production, guest slot at video_in_5 ("Input 6"), returnFeed set
    OL->>Flow: Activate production
    Flow->>Flow: Compact stored pads → mixerInputMap (video_in_5 → compact pad 2)  [flow-generator.ts:455-494]
    Flow->>Flow: guestSlotNumber(video_in_5) = Guest N  [flow-generator.ts:511-517]
    Flow->>Strom: num_inputs = N; input_2_label = "Guest N"  [flow-generator.ts:535-553]
    Note over OL: Guest joins → applyGuestSlotMixerLabel pushes invite name live at compact pad 2 [guest-slot-label.ts:128-146]
    Strom-->>MV: Multiview tile = compact pad 2 → "input 3", overlay label "Guest N"/invite
    MV->>Studio: Studio tiles resolve guest slots to Guest N / invite [TransitionPanel.tsx:185-196]
    Note over MV,Studio: BUG: non-return-feed / unresolved-slot fallback renders raw id "Whip" [TransitionPanel.tsx:197]
```

- **open-live** owns the stored↔compact identity (`mixerInputMap`), the build-time and live labels, and
  the controller WS translation. It is authoritative for both number (compact pad) and label (`Guest N`).
- **open-live-studio** consumes that identity for its tiles and watches the Strom WHEP multiview. It must
  not re-derive a tile name from the raw virtual-source id.

---

## Test plan

**Decided label fix (ship first):**
1. `open-live-studio` unit test: tile-naming for a guest slot (sourceId `Whip`, `returnFeed` present,
   no joined guest) renders `Guest N`, never `Whip` — covers the `TransitionPanel.tsx:197` path.
2. `open-live-studio` unit test: same slot with a joined guest renders the invite label.
3. Regression: a non-guest manual WHIP source (no `returnFeed`) still renders `WHIP Input`, not `Whip`.
4. `open-live` existing coverage already asserts the `Guest N` overlay label
   (`src/__tests__/flow-generator-guest-labels.test.ts`, `src/__tests__/mixer-input-map.test.ts`,
   `src/__tests__/guest-slot-label.test.ts`) — confirm green, add the `video_in_5 → compact 2 →
   "input 3"` worked-example assertion if not already present.
5. Live/beta: reproduce the #512 scenario on `openlivedev` beta (guest slot at `video_in_5`, guest joins);
   confirm the live multiview overlay reads `Guest N`/invite, never `Whip`.

**Number decision (after @svensson00):** add tests for whichever option is chosen — Option A: assert the
compacted number is shown (status quo, no new test beyond #4); Option B: assert mixer sizing / displayed
number equals the stored slot number; Option C: assert the overlay label carries both `Guest N` and the
stored slot number.

---

## Ops pre-check (before any code change)

Confirm the **reporting prod-se instance is not a stale deploy predating #460/#479** before acting — the
impl-failed analysis notes #458 was verified fixed on beta 2026-10-06 and prod-se may lag. A stale build
could emit a non-`Guest N` overlay and produce the symptom with no current-code defect.

- Verify the deployed `open-live` / `open-live-studio` build on prod-se includes #460 and #479
  (compare the running image tag / commit against `main` and the merge commits of #460/#479).
- If prod-se is stale: the correct remediation is a redeploy, and the label fix above still lands to
  close the client-side fallback regardless.
- Only once prod-se is confirmed current (or redeployed) does a reproduction there count as a
  current-code defect.

---

## Open questions

1. **[@svensson00]** Stored slot number vs compacted pad number in the live multiview — see
   [above](#open-product-question-requires-svensson00). Blocks the number change; does **not** block the
   label fix.
2. Does the raw-`Whip` symptom reproduce on the Strom WHEP overlay (`PgmPreview`/`PanePage`) on a
   *current* build, or only in the Studio tile fallback? Resolve via the ops pre-check + a current-build
   repro before scoping any backend label change (none is expected).
