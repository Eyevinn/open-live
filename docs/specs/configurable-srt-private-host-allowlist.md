# Spec: Deployment-configurable SRT private-host allowlist

- Issue: [Eyevinn/open-live#246](https://github.com/Eyevinn/open-live/issues/246) — "Make SRT private/loopback/link-local rejection deployment-configurable (self-hosted on-prem encoders)"
- Status: Draft (architect, Phase 1 — pre-implementation)
- Repos affected: `Eyevinn/open-live` (backend only)
- Type: config-gated relaxation of an existing SSRF guard (no new subsystem)

> Spec for #246.

---

## 1. Problem Statement

`srtUrl()` in `src/lib/url-validation.ts` unconditionally rejects any SRT target whose
host is a private, loopback, or link-local IP literal. The final gate is:

```ts
if (hostname && isPrivateHost(hostname)) {
  throw new Error('SRT URL must not target private, loopback, or link-local addresses');
}
```

(`src/lib/url-validation.ts:237-239`). `isPrivateHost()` (`src/lib/url-validation.ts:34-60`)
covers IPv4 10/8, 172.16/12, 192.168/16, 127/8, 169.254/16, 0.0.0.0; IPv6 `::1`, `::`,
`fc00::/7`, `fe80::/10`; and IPv4-mapped IPv6 in both dotted and hex-hextet forms.

This block is the SSRF hardening from #78 — correct for the cloud/OSC-hosted default,
where the GStreamer/Strom pipeline must not be steerable at internal services. But it is a
**blanket** block: a legitimate self-hosted / on-prem deployment that runs Strom and an SRT
encoder on the same LAN (e.g. sending SRT to `srt://192.168.1.50:9000`) is refused with no
override. The issue proposes a deployment-configurable escape hatch. Constraints:

- The #78 SSRF fix **MUST remain the default** — an unconfigured deployment behaves
  exactly as today (all private/loopback/link-local rejected). #78 is **not** reverted.
- The escape hatch must be scoped, not a global re-opening of the private-address surface.

`srtUrl()` is a pure, config-free function today; its callers pass an SRT string and
nothing else:

- `src/routes/sources.ts:30`, `:61`, `:167` — SRT/EFP source `address` validation
- `src/routes/outputs.ts:20`, `:107` — `mpegtssrt`/`efpsrt` output `url` validation

Both the caller form (`srt://host:port`) and the hostless listener form (`srt://:port`,
"binds all interfaces") flow through the same function.

---

## 2. Chosen Design (decision — not an open question)

**Adopt a host/CIDR allowlist, `TRUSTED_SRT_HOSTS`, NOT a coarse boolean.**

Rationale:

1. **Stays default-safe and minimally scoped.** A boolean `ALLOW_PRIVATE_SRT=true` re-opens
   the *entire* RFC1918 + loopback + link-local + IMDS (169.254.169.254) surface at once —
   including the AWS metadata endpoint the #58/#78 work specifically hardened against. An
   allowlist only unblocks the exact hosts/ranges an operator names; everything else stays
   rejected. It is a strict superset of the boolean's safety.
2. **Mirrors an existing, reviewed pattern.** `config.ts` already ships a
   comma-separated host allowlist, `TRUSTED_HOSTS` (`src/config.ts:82-85`:
   `.split(',').map(trim/lowercase).filter(Boolean)`), for the analogous
   X-Forwarded-Host SSRF concern. Reusing that shape keeps the config surface consistent
   and the parsing code familiar to reviewers.
3. **Operator intent is precise.** On-prem operators know their encoder's LAN address or
   subnet; naming it is low-friction and self-documenting in the deployment manifest.

The single genuine tradeoff — coarse boolean vs. allowlist — is resolved here in favour of
the allowlist. No product decision is deferred.

### CIDR support

`TRUSTED_SRT_HOSTS` accepts a comma-separated mix of:

- bare IP literals: `192.168.1.50`, `[fc00::1]` / `fc00::1`
- IPv4 CIDR ranges: `192.168.1.0/24`, `10.0.0.0/8`
- IPv6 CIDR ranges: `fc00::/7`

An entry matches a target host iff the host is an IP literal equal to (bare form) or
contained in (CIDR form) the entry. Non-IP DNS names are **never** matched (consistent with
`isPrivateHost()`, which only reasons about IP literals). Hostless listener targets
(`srt://:port`) have an empty host, already bypass the `isPrivateHost()` check, and are
therefore unaffected by this config.

---

## 3. API / Validation Design

### 3.1 `srtUrl()` signature change

`srtUrl()` gains one **optional** parameter so existing call sites and tests keep working
unchanged, and the config value is injected explicitly (keeping the module free of a direct
`config` import, matching how validation helpers are kept pure today):

```ts
export function srtUrl(url: string, trustedSrtHosts: readonly string[] = []): void
```

Length check, control-character check, and `SRT_URL_RE` format check
(`src/lib/url-validation.ts:212-221`) are **unchanged** — those are format/injection guards,
not address-range guards, and stay mandatory.

Only the final range gate changes:

```ts
if (hostname && isPrivateHost(hostname) && !isTrustedSrtHost(hostname, trustedSrtHosts)) {
  throw new Error(
    'SRT URL must not target private, loopback, or link-local addresses ' +
    '(add the host or CIDR to TRUSTED_SRT_HOSTS to allow it)'
  );
}
```

Precedence / posture:

1. Format + control-char + length checks run first (unchanged, non-overridable).
2. If host is **not** private → allowed (unchanged public-host behaviour).
3. If host **is** private → rejected **unless** it matches `trustedSrtHosts`.
4. Empty allowlist (the default) → identical to today: all private hosts rejected.

The allowlist can only *relax* a private-range rejection; it can never *bypass* the format,
control-character, or length guards, and it has no effect on public hosts.

### 3.2 New internal helper

```ts
// Not exported unless a test needs it; lives alongside isPrivateHost in url-validation.ts.
function isTrustedSrtHost(hostname: string, trusted: readonly string[]): boolean
```

- Normalises `hostname` the same way `isPrivateHost()` does (trim, strip `[` `]`, lowercase,
  and canonicalise IPv4-mapped IPv6 to its embedded IPv4 so `::ffff:192.168.1.5` matches a
  `192.168.1.0/24` entry — closing the same mapped-address gap #58 covered).
- For each `trusted` entry: bare literal → exact normalised-equality; `a.b.c.d/len` →
  IPv4 prefix match; `x::/len` → IPv6 prefix match. Malformed entries never match.
- Returns `false` for any non-IP hostname (DNS names are out of scope, as in `isPrivateHost`).

### 3.3 Caller changes

Each call site passes `config.trustedSrtHosts`:

- `src/routes/sources.ts:30,61,167` → `srtUrl(addr, config.trustedSrtHosts)`
- `src/routes/outputs.ts:20,107` → `srtUrl(url, config.trustedSrtHosts)`

Zod `superRefine` error surfacing (`ctx.addIssue`) is unchanged; the new hint text simply
flows through the existing message path.

---

## 4. Data Model / Config

New field in `config.ts`, parsed with the **existing** `TRUSTED_HOSTS` idiom
(`src/config.ts:82-85`):

| Property | Env var | Type | Default | Parsing |
|----------|---------|------|---------|---------|
| `trustedSrtHosts` | `TRUSTED_SRT_HOSTS` | `string[]` (IPs / CIDRs) | `[]` (empty — block all private, #78 preserved) | `.split(',').map(trim/lowercase).filter(Boolean)` |

```ts
/**
 * Optional allow-list of private/loopback/link-local IP literals or CIDR ranges
 * that SRT sources/outputs MAY target, for self-hosted deployments whose SRT
 * encoder sits on the same private LAN as Strom. Comma-separated
 * (e.g. "192.168.1.0/24,10.10.0.5"). Empty by default: the #78 SSRF hardening
 * blocks ALL private/loopback/link-local SRT targets unless explicitly listed
 * here. This only affects srtUrl(); it never relaxes http/graphic SSRF checks.
 */
trustedSrtHosts: (process.env['TRUSTED_SRT_HOSTS'] ?? '')
  .split(',')
  .map((h) => h.trim().toLowerCase())
  .filter(Boolean),
```

No CouchDB/document schema change: this is deployment config, not per-resource state.

---

## 5. Service Interactions

```mermaid
flowchart TD
  A[Source/Output route: srtUrl(url, config.trustedSrtHosts)] --> B{Format / control-char / length OK?}
  B -- no --> R1[Reject: format error]
  B -- yes --> C[Extract hostname from authority]
  C --> D{hostname empty?\n(listener form srt://:port)}
  D -- yes --> OK[Accept]
  D -- no --> E{isPrivateHost(hostname)?}
  E -- no --> OK
  E -- yes --> F{isTrustedSrtHost in TRUSTED_SRT_HOSTS?}
  F -- yes --> OK
  F -- no --> R2[Reject: private/loopback/link-local\n+ hint to add to TRUSTED_SRT_HOSTS]
```

---

## 6. Configuration

- **Cloud / OSC-hosted (default):** leave `TRUSTED_SRT_HOSTS` unset. Behaviour is identical
  to today; #78 protection intact.
- **Self-hosted on-prem, single encoder:** `TRUSTED_SRT_HOSTS=192.168.1.50`.
- **Self-hosted, whole encoder subnet:** `TRUSTED_SRT_HOSTS=192.168.1.0/24`.
- **Multiple ranges:** `TRUSTED_SRT_HOSTS=10.10.0.0/16,192.168.1.50,fc00::/64`.

Document in the deployment README/env table alongside `TRUSTED_HOSTS`, with an explicit
security note: **only** widen this to ranges you physically control; never add
`169.254.0.0/16` (cloud metadata) or `0.0.0.0/8`.

### Test matrix

| # | `TRUSTED_SRT_HOSTS` | Input | Expected |
|---|---------------------|-------|----------|
| 1 | (unset) | `srt://192.168.1.10:5005` | reject (default = #78 unchanged) |
| 2 | (unset) | `srt://example.com:9000` | accept (public host, unchanged) |
| 3 | (unset) | `srt://:6000?mode=listener` | accept (listener form, unchanged) |
| 4 | `192.168.1.10` | `srt://192.168.1.10:5005` | accept (exact literal match) |
| 5 | `192.168.1.0/24` | `srt://192.168.1.50:9000` | accept (in CIDR) |
| 6 | `192.168.1.0/24` | `srt://192.168.2.50:9000` | reject (outside CIDR) |
| 7 | `192.168.1.0/24` | `srt://10.0.0.1:9000` | reject (different private range) |
| 8 | `10.0.0.0/8` | `srt://169.254.169.254:80` | reject (IMDS not listed) |
| 9 | `192.168.1.0/24` | `srt://[::ffff:192.168.1.5]:9000` | accept (mapped IPv6 canonicalised) |
| 10 | `fc00::/7` | `srt://[fc00::1]:9000` | accept (IPv6 CIDR) |
| 11 | `fc00::/7` | `srt://[fe80::1]:9000` | reject (link-local, not in fc00::/7) |
| 12 | `192.168.1.10` | `srt://example.com:9000?x=a\r\n` | reject (control chars — allowlist never bypasses format guards) |
| 13 | `0.0.0.0/8` (misconfig) | `srt://127.0.0.1:9000` | reject (loopback not in the listed range) |
| 14 | `example.com` (DNS entry) | `srt://example.com:9000` | accept, but via public-host path — DNS names are not matched as trusted private hosts |

---

## 7. Open Questions

None require a human product decision. Resolved in this spec:

- **Boolean vs. allowlist** → allowlist (`TRUSTED_SRT_HOSTS`); see §2.
- **CIDR vs. bare IPs only** → support both; bare IP is just a `/32`/`/128` special case.
- **How config reaches the pure validator** → optional 2nd arg to `srtUrl()`, injected by
  callers from `config.trustedSrtHosts`; module stays `config`-free.
- **Listener form interaction** → unaffected (empty host already bypasses the range gate).

Non-blocking follow-ups (implementer's discretion, not gating this spec):

- Whether to log a single startup warning when `TRUSTED_SRT_HOSTS` is non-empty (recommended,
  for audit visibility). Low effort; suggested but optional.

---

## 8. Risks

- **SSRF regression (highest):** an over-broad entry (`0.0.0.0/0`, `169.254.0.0/16`) re-opens
  the surface #78 closed. Mitigations: default empty; only listed ranges relaxed; format /
  control-char / length guards remain non-overridable; docs explicitly warn against
  metadata/wildcard ranges. The allowlist is strictly narrower than the rejected boolean.
- **Misconfiguration / footgun:** malformed CIDR entries silently never match (fail-closed —
  the safe direction: a bad entry blocks rather than opens). IPv4-mapped IPv6 is canonicalised
  before matching so a `192.168.x` allow entry cannot be bypassed *or* silently missed via the
  `::ffff:` form.
- **Scope creep:** this changes **only** `srtUrl()`. `httpUrlOnly()` / `graphicUrl()` SSRF
  behaviour is untouched — the allowlist must not leak into HTTP/graphic validation.
