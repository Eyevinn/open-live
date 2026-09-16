import type { ProductionSourceAssignment, SourceDoc } from '../db/types.js';
import { assignAudioChannels } from './audio-channels.js';

/**
 * Per-guest return feed (mix-minus) topology helpers (epic #208, issue #300,
 * `docs/specs/guest-calling-intercom.md` §"Return feed design").
 *
 * A return feed is a post-fader aux bus on `builtin.mixer` with a send from
 * every audio channel. `program-minus` (default) closes the guest's own send;
 * `program` opens it. Send levels (`ch{N}_aux{M}_level`) are live so the mode
 * can change mid-show.
 *
 * BUS-NUMBERING INVARIANT: return buses are numbered *after* the crew aux buses
 * (aux `numCrewAuxBuses + 1` … `numCrewAuxBuses + numReturns`). Crew aux buses
 * are wired into every WHEP output; return buses must be EXCLUDED from that loop
 * (a return goes to exactly one guest's WHEP output, its own single audio track),
 * so anything iterating aux buses for the WHEP fan-out must cap at
 * `numCrewAuxBuses`, never `num_aux_buses` (which now also counts return buses).
 */

export type ReturnMode = 'program' | 'program-minus';

/** Send level for an open send (unity). A closed send is 0. */
export const RETURN_SEND_OPEN = 1.0;
export const RETURN_SEND_CLOSED = 0.0;

export interface ReturnBus<S> {
  /** The assignment (guest input) this return belongs to. */
  assignment: ProductionSourceAssignment;
  /** Guest's own 0-based audio channel — the one excluded in `program-minus`. */
  ownChannel: number;
  /** 1-based aux bus index on the mixer (already offset past the crew aux buses). */
  auxBus: number;
  /** Current return mode from the assignment's `returnFeed`. */
  mode: ReturnMode;
  source: S;
}

/**
 * Numbers the return aux buses for a production's assignments. Only assignments
 * carrying a `returnFeed` get a return bus, and only ones that resolve to an
 * audio channel (an input without audio has nothing to be minus'd from). Return
 * buses are numbered after the crew aux buses in the same mixerInput order the
 * audio channels are numbered, so the mapping is stable across activations.
 *
 * @param assignments   the production's source assignments
 * @param resolve       looks up a source by id (virtual or DB)
 * @param numCrewAuxBuses number of crew aux buses (the returns start after these)
 */
export function assignReturnBuses<S>(
  assignments: readonly ProductionSourceAssignment[],
  resolve: (sourceId: string) => S | undefined,
  numCrewAuxBuses: number,
): ReturnBus<S>[] {
  const channels = assignAudioChannels(assignments, resolve);
  const channelByMixerInput = new Map(
    channels.map((c) => [c.assignment.mixerInput, c]),
  );
  const returns: ReturnBus<S>[] = [];
  for (const c of channels) {
    if (!c.assignment.returnFeed) continue;
    const found = channelByMixerInput.get(c.assignment.mixerInput);
    if (!found) continue;
    returns.push({
      assignment: c.assignment,
      ownChannel: c.channel,
      auxBus: numCrewAuxBuses + returns.length + 1,
      mode: c.assignment.returnFeed.synced,
      source: c.source,
    });
  }
  return returns;
}

/**
 * Builds the `ch{N}_aux{M}_level` send-matrix properties for a single return
 * bus. Every audio channel sends into the bus at unity, except:
 *   - the guest's own channel in `program-minus` (closed — mix-minus), and
 *   - any channel currently taken off the main program (`to_main` false), which
 *     is mirrored so a return never keeps a channel the crew removed.
 *
 * @param auxBus        1-based aux bus index of this return
 * @param ownChannel    0-based own channel to exclude in program-minus
 * @param mode          program | program-minus
 * @param numChannels   total audio channels on the mixer
 * @param toMainByChannel optional 0-based channel → to_main state; a false entry
 *                        forces that channel's send closed regardless of mode
 */
export function returnSendMatrix(
  auxBus: number,
  ownChannel: number,
  mode: ReturnMode,
  numChannels: number,
  toMainByChannel?: ReadonlyMap<number, boolean>,
): Record<string, number> {
  const props: Record<string, number> = {};
  for (let ch = 0; ch < numChannels; ch++) {
    const isOwn = ch === ownChannel;
    const closedByMode = isOwn && mode === 'program-minus';
    const offProgram = toMainByChannel ? toMainByChannel.get(ch) === false : false;
    const open = !closedByMode && !offProgram;
    props[`ch${ch + 1}_aux${auxBus}_level`] = open ? RETURN_SEND_OPEN : RETURN_SEND_CLOSED;
  }
  return props;
}

/**
 * Mirrors a set of `ch{N}_to_main` changes into the return sends. When the crew
 * mutes / audio-follow-video takes a channel off program, every return whose own
 * send policy would otherwise keep that channel open must close it in the same
 * Strom update (spec §"Mirror `to_main` into return sends"). Returns the merged
 * `ch{N}_aux{M}_level` properties to spread into the Strom block update.
 *
 * @param returns          the return buses (from `assignReturnBuses`)
 * @param toMainChanges    0-based channel → new to_main value being applied now
 */
export function mirrorToMainIntoReturns<S>(
  returns: readonly ReturnBus<S>[],
  toMainChanges: ReadonlyMap<number, boolean>,
): Record<string, number> {
  const props: Record<string, number> = {};
  for (const r of returns) {
    for (const [ch, toMain] of toMainChanges) {
      const isOwn = ch === r.ownChannel;
      const closedByMode = isOwn && r.mode === 'program-minus';
      // A channel taken off program closes; a channel put back on program reopens
      // unless the mode keeps it closed (the guest's own channel in program-minus).
      const open = toMain && !closedByMode;
      props[`ch${ch + 1}_aux${r.auxBus}_level`] = open ? RETURN_SEND_OPEN : RETURN_SEND_CLOSED;
    }
  }
  return props;
}

/** Type helper: the resolved-source shape return-bus assignment needs. */
export type ReturnSourceLike = Pick<SourceDoc, 'streamType' | 'name'>;

/** Persisted per-guest return bus (mirror of ProductionDoc.returnBuses entries). */
export interface PersistedReturnBus {
  mixerInput: string;
  auxBus: number;
  ownChannel: number;
  mode: ReturnMode;
}

/**
 * Builds the `ch{N}_aux{M}_level` mirror properties for a set of persisted return
 * buses given `ch{N}_to_main` changes the crew is applying now (mute / AFV). One
 * 0-based channel key maps to its new to_main value. A channel taken off program
 * closes in every return; a channel put back reopens unless a return keeps it
 * closed by mode (its own channel in program-minus). Spread the result into the
 * SAME Strom block update so a return never keeps a channel the crew removed.
 */
export function mirrorToMainForPersistedReturns(
  returnBuses: readonly PersistedReturnBus[],
  toMainChanges: ReadonlyMap<number, boolean>,
): Record<string, number> {
  const props: Record<string, number> = {};
  for (const rb of returnBuses) {
    for (const [ch, toMain] of toMainChanges) {
      const closedByMode = ch === rb.ownChannel && rb.mode === 'program-minus';
      const open = toMain && !closedByMode;
      props[`ch${ch + 1}_aux${rb.auxBus}_level`] = open ? RETURN_SEND_OPEN : RETURN_SEND_CLOSED;
    }
  }
  return props;
}
