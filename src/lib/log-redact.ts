/**
 * Redacts sensitive values from log objects to prevent credential leakage.
 *
 * The `secret` / `token` sub-patterns intentionally match by substring, so the
 * guest-calling credentials `GUEST_INVITE_SECRET` (HMAC signing key) and
 * `INTERCOM_MANAGER_TOKEN` — as well as their camelCase config keys
 * `guestInviteSecret` / `intercomManagerToken` — are redacted here without a
 * dedicated rule (epic #208, issue #299, spec §Risks: "Redact
 * INTERCOM_MANAGER_TOKEN and GUEST_INVITE_SECRET in logs").
 *
 * `address` / `url` are redacted because an authenticated HTML source (Design D,
 * token-in-URL — `docs/specs/authenticated-html-sources.md`, ADR-003) carries a
 * signed/expiring access token inside the source `address`, which becomes the
 * `cefsrc` element's `url` property in the generated flow. Treat both as secrets
 * in logs so a token-bearing HTML-source address never leaks (issue #315). SRT
 * addresses (which may embed a `?passphrase=`) benefit from the same rule.
 */

const SENSITIVE_KEYS =
  /srt_uri|passphrase|streamid|authorization|token|pat|secret|access_?key|address|url/i;

export function redactSensitive(obj: unknown): unknown {
  if (Array.isArray(obj)) {
    return obj.map(redactSensitive);
  }
  if (obj !== null && typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      result[key] = SENSITIVE_KEYS.test(key) ? '[REDACTED]' : redactSensitive(value);
    }
    return result;
  }
  return obj;
}

/**
 * Returns a safe projection of a Strom flow for logging.
 * Strips all block/element properties — keeps only IDs and types.
 */
export function safeFlowProjection(flow: Record<string, unknown>): unknown {
  return {
    blockCount: Array.isArray(flow['blocks']) ? (flow['blocks'] as unknown[]).length : 0,
    blocks: Array.isArray(flow['blocks'])
      ? (flow['blocks'] as Record<string, unknown>[]).map((b) => ({
          id: b['id'],
          block_definition_id: b['block_definition_id'],
        }))
      : [],
    elementCount: Array.isArray(flow['elements']) ? (flow['elements'] as unknown[]).length : 0,
    elements: Array.isArray(flow['elements'])
      ? (flow['elements'] as Record<string, unknown>[]).map((e) => ({
          id: e['id'],
          element_type: e['element_type'],
        }))
      : [],
    linkCount: Array.isArray(flow['links']) ? (flow['links'] as unknown[]).length : 0,
  };
}
