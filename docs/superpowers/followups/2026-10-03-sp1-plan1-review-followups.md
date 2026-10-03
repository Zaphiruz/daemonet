# SP1 plan 1 — review follow-ups

Deferred Minor findings from the per-task reviews and the final whole-branch review of SP1 plan 1 (foundations),
merged 2026-10-03. None blocked the merge. The final review triaged them all as "can wait"; pick them up when the
touched code is next edited.

## Fixed before merge (for the record)

- Chain seal: SHA-256 keystream instead of a repeating XOR keyed by the stage-one answer (the old seal was recoverable
  from the public stage-two JSON prefix). SP3a plan 2 was updated to keep it.
- Pinned RNG known-answer vectors (`packages/rules/test/rng.test.ts`).
- Content tables deep-frozen (`packages/rules/src/freeze.ts`); SP3a plan 1 carries a constraint to keep them frozen.

## Open

### rules — RNG and formulas
- `rng.chance(p)` does not validate `p` (NaN or out-of-range values clamp silently).
- `rng.int`: the "range too large" branch is untested; no unsafe-integer (> 2^53) check.
- String seeds collapse to 32 bits (FNV-1a); numeric seeds alias via `seed | 0` (`createRng(2**32) ≡ createRng(0)`).
  Decide before SP1 plan 2 persists seed formats: derive sub-streams from one master `Rng`, or widen string seeding.
- `computeStats` does not validate `level` (0 or > 64 pass).
- Stats monotonicity property test only uses nature 0.
- `damage` doc comment omits the `power === 0 → 0` case; combat tests lack special-move (focus/resolve), non-STAB,
  power-0 and haste+throttle cases; a test comment calls `traceroute` physical (it is special).
- No input guards on `effectiveCooldownMs` (haste ≤ −256) or `splitXp`.

### rules — content and capture
- `items.ts`: one-use `getItemOrNull` helper and `id as ItemId` casts on the lookup map.
- `species.ts`: the constant named `NULL` reads like the keyword.
- `STAT_KEYS` (constants.ts) is an exported array that is not frozen.
- `getFamily` / `hasFamily` are public but `ChallengeFamily` / `Stage` types are not exported.
- Packet `generate` does not validate `size` (unreachable through `challengeSize`, minimum 8).
- `capture.test.ts`: the 64 KiB test comment claims "4x headroom" that size 1024 does not have.
- `hammingEncode` known-value test has only two vectors.
- Chain tests omit 3 types and an unknown second family; stage one is generated before the second family is validated.
- Low-entropy stage-one answers (Null's sum, Packet's 32-bit checksum) bound the chain seal's strength regardless of
  the keystream.

### shared — protocol
- `parseClientMessage` fully parses 4–16 KiB non-submit messages before rejecting them (a cheap pre-check is possible).
- `auth.d.token` max 8192 can never be reached under the 4 KiB limit; lower it or give `auth` the larger limit before
  SP1 plan 3 carries OIDC tokens.
- `shared` re-declares literals it could import from `rules` (tool ids, status ids, the 8/2/4/15 limits).
- Protocol tests lack: byte-vs-character limit, positive `Entity` / `OperatorSelf` / `snapshot` parsing,
  `authOk` / `err` / `kick`, operator-name length bounds.

### For later plans (recommendations from the final review)
- Per-family zod schemas for `params` / `payload`, so the SDK can validate `captureStart` (today `z.unknown()`).
- Decide which capture helpers the SDK re-exports (`fnv1a32Hex`, `packetCrc`, `hammingEncode`, `WORDS`,
  `unsealStage`); player-facing docs must carry the algorithms, since the source is private.
- `vitest.config.ts` is not typechecked.
