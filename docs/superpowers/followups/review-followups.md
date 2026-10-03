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
