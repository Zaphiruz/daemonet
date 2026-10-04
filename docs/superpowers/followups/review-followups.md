# Review follow-ups

Deferred Minor findings from task reviews and final reviews, per plan. None blocked a merge.
SP1 plan 1's list is in `2026-10-03-sp1-plan1-review-followups.md`.

## 2026-09-29-daemonet-sp1-plan2-sim-core

Fixed before merge: idempotent intent completion across reconnects; findPath returns null at the expansion cap

- T1: host/spawn walkability and region/wall overlap invariants not tested
- T2: findPath may return a suboptimal path when the expansion cap trips after the goal was discovered (should return null)
- T2: grid "never cuts corners" test is vacuous (straight path); randomWalkableIn null/y-bound untested; no over-cap null test
- T3: core index does not export Out (brief interface list says it does); systems import ../out.js
- T3: removeOperator leaves wild tag/aggro/damagedBy refs; no completeIntent/freeRamSlot/activate tests yet
- T4: no tests for recall→run cooldown bypass, useItem gate, use E_INVALID, stalled moveTo, restore cancel by hit
- T4: useItem consumes restore on a full-HP daemon; claimStarter hardcodes energy 128 (use ENERGY_MAX)
- T5: no tests for level-up via awardXp, wild hit on operator, territorial/timid/wanderer, cone, missing-target E_INVALID
- T5: wild aggro keyed to the attacking daemon id; recall clears retaliation until next hit
- T6: hardened-doubling test only calls pure challengeSize; untested timid flee, Disk confirm, start rejections, capture XP
- T6: commitCapture does not re-check RAM/Disk space at commit; submit does not re-validate target hp
- T6: removeOperator during a committing capture drops tool refund / persist_failed (world.ts completeIntent early return)
- T7: p99 budget test uses 160 samples (2nd-slowest step); determinism test doesn't assert bots produced combat; weightedPick on empty table throws confusingly
Task F: minor (deferred): battleStart not emitted when first contact is a capture
Task F: minor (deferred): all-crashed teleport goes to subnet.spawn, spec says host (works on lo: spawn 2 tiles from host)
Task F: minor (deferred): findPath allocates four grid-sized arrays per call (hot path under load)
Task F: minor (deferred): Math.hypot/acos not cross-engine deterministic — document if replays must match across Node versions
Task F: minor (deferred): XP recipients filtered by RAM not running (spec: running daemons that dealt damage)
Task F: minor (deferred): timid wild flees 8 tiles vs sniff range 4 — design note
Task F: minor (deferred): tag expiry runs in upkeep rather than with crash resolution
Task F: minor (deferred): recommend World.pendingIntents() so the runtime can drain/refuse reconnects with pending intents

## 2026-09-29-daemonet-sp1-plan3-runtime

Fixed before merge: store P2002 classification + RAM-only checkpoints; auth discovery/IdP resilience; spectator sessions; reply routing by connection; WS crash paths, backpressure, shutdown kick order; SDK connect/reconnect policy; device-login single-flight refresh; configurable per-IP cap; leave/connect race; serialized checkpoints

- T1: prisma.config.ts falls back to '' DATABASE_URL (opaque error when unset)
- T2: Memory checkpoint skips unknown operators while Prisma throws and rolls back the whole batch; no tests for 'daemon not found', failed-intent replay, failNext; stateFields duplicated
- T2: DB test files share one database — keep vitest fileParallelism false when a second DB suite arrives
- T3: userinfo sub not compared to token sub; error messages carry jose internals/group name (transport must return generic text); injected opts.userinfo throws escape as non-AuthError
- T4: replyTo map leaks an entry when an intent outlives its operator; keyed operatorId:reqId so reqId reuse across a takeover can misroute an intent reply (key by connection id)
- T4: maxSpectators reject on a brand-new session leaves leaveAtTick null; untested: spectator cap, idle timeout, violation kick, reauth, radius shrink, bucket E_RATE, store-failure auth path
- T5: shutdown skips game.shutdown if server.close rejects; fatal handlers log no stack; 429 path writes then destroys immediately (use socket.end); slow-consumer close untested; TRUST_PROXY_HOPS must be documented for deploy
- T6: close() during the first token await leaves ready unsettled (start() callers only); canUse throws on an unknown move id; GameClient delta merge/bestMoveAgainst untested
- T7: sharedRefresh caches a stale resolved false when refreshToken is null (finally runs before ??= assignment); transient errors during device polling abort the login; discovery runs before the cache is consulted; background-timer path untested
- T8: load.ts leaves a connection open when claimStarter fails; example packet solver throws on a missing fragment; per-IP default 16 lives in config and server; main.ts formatting
Task F: minor (deferred): server never enforces token exp during a session (kick on exp without reauth — SP2); auth/reauth bound by the 4 KiB message limit (large Authentik tokens); /ws/ready uncached DB round-trip; TRUST_PROXY_HOPS must be set in plan 4 (3-proxy chain) or the per-IP cap locks everyone out
Task F: minor (deferred): plan doc still shows maxConnectionsPerIp optional and close()-only server

## 2026-09-29-daemonet-sp1-plan4-infra-deploy

Fixed before merge: deploy gated to main via environment + DAEMONET_DEPLOY_ENABLED; Vault env allowlist; secrets off argv; Vault TLS without --cacert; runner ssh setup; safe staging; read-only migrations verified; ops hand-off in followups/ops-pending.md (Tasks 2-8 are the user's)

- T1: Vault token still on curl argv in deploy.yml; staging Ctrl+C advice wrong without ssh -t; staging DB shares the prod role; read-only migration with pending changes unexercised; Caddy root with default caps
Task F: minor (deferred): provision-secrets python3 may hit the Windows Store stub; $PY unquoted

## 2026-09-30-daemonet-sp2-plan1-api

Fixed before merge: api Vault allowlist + hardened entrypoint; honest session tests; redirect URI from config; separate AUTHENTIK_WEB_ISSUER_URL; no-store on /api; OIDC code kept out of logs; 30-day absolute sessions + admin from Operator.isAdmin; atomic script versions; error codes

- T2: sliding sessions keep isAdmin/groups snapshotted at login (no absolute cap / re-check); touch/requireAdmin untested; PKCE-clear-on-error untested
- T3: concurrent PUTs compute the same version → 500 (use version increment in upsert or map P2002 → 409); version param accepts 0x10/1e0 and > int32 → 500 (validate /^\d{1,9}$/)
- T3: versions list loads full sources to compute bytes; missing tests (non-string source, cross-operator isolation, byte-vs-char limit)
- T4: ticket/disk/ready tests cover only happy paths (no 401/403, hash-only, sweep, ownership, 503 branch); per-IP ticket rate limit shared behind NAT
- T5: ticket verifier slices the prefix without checking it; concurrency test doesn't assert winner claims
- T6: OPERATIONS step 10 homelab text omits the web provider / api
Task F: minor (deferred): non-AppError 403/415 map to bad_request; Session.groups now unused; sha256 helper duplicated in api and sim (no shared test that an api-minted ticket passes the sim verifier); logout without id_token_hint may not return to the site

## 2026-09-30-daemonet-sp2-plan2-sandbox-sprites

Fixed before merge: real script escaping/robust init/allowlisted relay; then redesign: static /sandbox.html with its own CSP, player scripts in a Worker with stop + heartbeat watchdog, bridge reqId namespacing, flood budget + onViolation, configurable command share, reconnect contract; verify page under a production host CSP (headless Chrome + Firefox 12/12)

- T1: PortSocket trusts close-frame field types; no readyState guard on late messages; no-reconnect test is time-based
- T2: escapeForScript 'js' mode doesn't handle the <!-- <script double-escape state (doc it); init-listener test is string-matching only; self-navigation / WebRTC exfil of game state (host frame-src)
- T3: seam-column smoothing counts only the horizontal mirror neighbour; signature not validated (16 wraps to tier 0)
Task F: minor (deferred): worker script-src 'self' admits same-origin script loads (never serve user content as JS on the frontend origin); init after stop leaks the port; watchdog timers throttled in hidden frames / slow first load may report unresponsive; main() throwing posts error without finished; verify "cookie blocked" line tautological; Safari and real Caddy unverified

## 2026-09-30-daemonet-sp2-plan3-web-client

Fixed before merge: autosave failures surface and keep the script dirty; error boundaries around panels and the world canvas; exported TRANSIENT_KICKS, ticket fetch timeout, sandbox start notice, lazy Script tab, typed entities, TICK_HZ, hoisted Monaco options; Caddyfile CSP comment

- T1: sendFrame JSON.parse unguarded (bridge sends validated frames only)
- T2: sandbox online probe is registered by connection.ts at module load (sandbox.start refuses if connection.ts is never imported); offline refusal leaves status stopped
- T3: ScriptPanel can briefly adopt an older refetch while a later autosave is in flight (skip adoption while saving); Monaco loads eagerly on the login page
- T4: CI failure-log docker logs errors if the container never started; shipped HEALTHCHECK probes :80 so the CI container on :4173 never reports healthy; CI host-network path not yet run on a GitHub runner (first CI run on main will tell)
Task F: minor (deferred): ScriptPanel shows "save failed" until the next save is sent, even with newer unsaved edits; no automatic retry after a failed save
Task F: minor (deferred): ScriptPanel's pending autosave timer is not cleared on unmount (a quick tab switch can adopt a stale version)
Task F: minor (deferred): sandbox start notice is armed on iframe load, so a frame that never loads gets no notice

## 2026-09-30-daemonet-sp3a-plan1-content

Fixed before merge: StatusSchema typed from STATUS_IDS without a cast; BestiaryRow.stage doc; ItemId union restored; item/budget/chart/move-slot test pins; crypto status slot and lo comments

Task F: minor (deferred): kernel↔signal and shell↔root are mutual ×2 strengths — designer yes/no before SP3a plan 3 tunes around it
Task F: minor (deferred): id reuse across namespaces (cosmicray move + evolution item; sigstop move + species) — accept or add a cross-namespace uniqueness test
Task F: minor (deferred): Codex panel still renders a 4×4 "SP1 types" chart (SP3a plan 4 replaces it)
Task F: minor (deferred): add a SUBNET_IDS constant so bestiary `subnet` requirements can be validated once the other subnets exist

## 2026-09-30-daemonet-sp3a-plan2-challenge-families

Fixed before merge: every answer fits submitCapture (MAX_ANSWER_BYTES; cloud ≤256 keys, shell input cap); chain stages min(size,256); SDK re-exports all 16 families; socket/shell/root/buffer/stack doc fixes; socket/root tables frozen, socket answer bounded

- T1: no direct decoy-count assertion (⌊size/8⌋/⌊size/4⌋) for the new families
- T1: thread stray-unlock fixture doesn't isolate the edge (unclamped-counter bug cancels out); add stray-unlock-then-lock fixture
- T2: shell -d<space> would break stage.split(' ') (latent; generator emits ','); literal U+FFFF in test source → use escape
- T2: root fixture for owner denied by owner triple while other grants
- T3: heap "bad" frees can hit live ids (real frees, not inert decoys)
Task F: minor (deferred): shell grep-only answer bound is probabilistic (~30% measured headroom), not provable
Task F: minor (deferred): sandbox bridge.ts:168 compares UTF-16 raw.length against a byte limit (MAX_SUBMIT_BYTES)
Task F: minor (deferred): proxy b64 spreads up to ~8 KB into String.fromCharCode(...) — chunk it; HeapParams.events duplicates payload length
Task F: minor (deferred): spec §5 drift to record — thread events have no `t`; socket has a `connections` param; MAX_CHALLENGE_SIZE=1024 clamp and chain stages min(size,256) deviate from the design specs' sizing text
Task F: parked: family doc comments vanish at runtime (rules is private) and SP3a plan 4 has no step surfacing them in the Codex — carry-forward #22 tells plan 4 to add ChallengeFamily.rules text
