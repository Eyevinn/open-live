import { getGuestInvitesDb, getGuestSessionsDb } from '../db/index.js';
import type { GuestSessionDoc } from '../db/types.js';

/**
 * Revoke a production's outstanding guest invites and mark its live guest
 * sessions `left` when it stops (issues #325, #414).
 *
 * A guest invite token is the security boundary of guest calling: deactivating a
 * production must invalidate its invites so a still-TTL-valid token can no longer
 * redeem a session (and provision a fresh intercom line) against a finished
 * production. Invites are deleted (mirroring the per-invite DELETE revoke in
 * guests.ts); live sessions (state !== 'left') are transitioned to `left`
 * (mirroring the kick/leave transition). The join guard in guests.ts is the
 * belt-and-braces backstop for invites created between this sweep and any later
 * write. Failures are logged per-doc and swallowed — the caller treats the whole
 * sweep as best-effort, matching the Strom/intercom teardown contract.
 */
export async function revokeGuestInvitesForProduction(
  productionId: string,
  log: { warn: (obj: unknown, msg: string) => void },
): Promise<void> {
  // Delete outstanding invites for this production.
  const invitesDb = getGuestInvitesDb();
  const invites = await invitesDb.find({
    selector: { type: 'guest-invite', productionId },
  });
  for (const invite of Array.isArray(invites?.docs) ? invites.docs : []) {
    if (!invite._rev) continue;
    try {
      await invitesDb.destroy(invite._id, invite._rev);
    } catch (err) {
      log.warn({ err, inviteId: invite._id, productionId }, 'guest invite revoke on production end failed');
    }
  }

  // Mark any live guest sessions `left`.
  const sessionsDb = getGuestSessionsDb();
  const sessions = await sessionsDb.find({
    selector: { type: 'guest-session', productionId },
  });
  const now = new Date().toISOString();
  for (const session of Array.isArray(sessions?.docs) ? sessions.docs : []) {
    if (session.state === 'left') continue;
    try {
      const leftSession: GuestSessionDoc = { ...session, state: 'left', updatedAt: now };
      await sessionsDb.insert(leftSession);
    } catch (err) {
      log.warn({ err, guestId: session._id, productionId }, 'guest session leave on production end failed');
    }
  }
}

/**
 * Best-effort guest sweep for every path that ends a production — explicit
 * deactivate, idle-watchdog auto-deactivate and startup reconcile finding the
 * flow gone (issue #414). Never throws: a failed sweep is logged and must not
 * block the status transition. Call this from any new end path.
 */
export async function sweepGuestsOnProductionEnd(
  productionId: string,
  log: { warn: (obj: unknown, msg: string) => void },
): Promise<void> {
  try {
    await revokeGuestInvitesForProduction(productionId, log);
  } catch (err) {
    log.warn({ err, productionId }, 'guest-invite revoke failed — continuing');
  }
}
