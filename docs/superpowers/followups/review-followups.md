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
