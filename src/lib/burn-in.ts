/**
 * Latency burn-in: when a production asks for it (`values.latency_burn_in: true`), each input is stamped
 * with its time and the time is drawn into the picture, as UTC text and a machine-readable code row
 * (Strom's `builtin.reference_timestamp` with `burn_in`). A viewer that decodes the row on any output
 * downstream of the input, the program output of this production or a replay of what the TAMS tap
 * recorded, can tell how long the frame took to get there: that is how the Open Replay Studio shows delays.
 *
 * The block sits right after the input, before the lipsync offset, so the mixers, the ISO recorder and the
 * TAMS tap all see the burned-in picture. The stamp is the pipeline clock's time for the frame as it
 * leaves the input, so the delay counts from there: what happens before the input (the camera, the network,
 * the SRT buffer) is not in it.
 *
 * It draws on the picture, so it is a test mode and off by default.
 */

/** Strom block that stamps frames with their time and can burn the time in. */
export const BURN_IN_BLOCK = 'builtin.reference_timestamp';

/** Whether the production's values ask for the burn-in. */
export function burnInRequested(values: Record<string, unknown> | undefined): boolean {
  return values?.['latency_burn_in'] === true;
}

interface TapLike {
  video: string;
  padIndex: number;
  y: number;
}
interface FlowLike {
  blocks: Array<Record<string, unknown>> | unknown[];
  links: Array<Record<string, unknown>> | unknown[];
}

/**
 * Puts a burn-in block between each tapped input's video output and its `time_offset` block, and points the
 * tap at the burn-in's output so everything built on the tap (recorder, TAMS) gets the burned-in picture.
 * Returns the mixer inputs it burned in.
 */
export function spliceBurnIn(
  flow: FlowLike,
  taps: ReadonlyMap<string, TapLike>,
  endpointSuffix: string,
  x: number,
): string[] {
  const links = flow.links as Array<Record<string, unknown>>;
  const burned: string[] = [];
  for (const [mixerInput, tap] of taps) {
    const offsetPrefix = `b-offset-${tap.padIndex}-${endpointSuffix}:`;
    const at = links.findIndex((l) => l['from'] === tap.video && String(l['to']).startsWith(offsetPrefix));
    if (at < 0) continue; // not wired to an offset block: leave the input alone
    const id = `b-burnin-${tap.padIndex}-${endpointSuffix}`;
    (flow.blocks as Array<Record<string, unknown>>).push({
      id,
      block_definition_id: BURN_IN_BLOCK,
      name: `Burn-in ${mixerInput}`,
      properties: { timescale: 'utc', burn_in: true },
      position: { x, y: tap.y },
    });
    const to = links[at]!['to'];
    links.splice(at, 1, { from: tap.video, to: `${id}:in` }, { from: `${id}:out`, to });
    tap.video = `${id}:out`;
    burned.push(mixerInput);
  }
  return burned;
}
