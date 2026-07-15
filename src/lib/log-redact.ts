/**
 * Redacts sensitive values from log objects to prevent credential leakage.
 */

const SENSITIVE_KEYS = /srt_uri|passphrase|streamid|authorization|token|pat|secret|address|password|key/i;

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
