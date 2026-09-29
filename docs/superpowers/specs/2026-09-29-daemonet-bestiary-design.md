# Daemonet — Bestiary

**Status:** approved structure, 2026-09-29; names and trees are a first pass.
**Parent:** `2026-09-27-daemonet-design.md` §7 (daemon model) and §7.1
(evolution rules).

This document fixes the **50 lines and 256 species**: names, types, tree
shapes, evolution levels, branch requirements and each form's stat identity.
Exact base stats, learnsets and move lists are content data authored and tuned
in SP3; they must respect the identities and stage budgets below.

## 1. Rules recap

- **Evolution levels are powers of 2:** 8, 16, 32, and 64 (capstones only).
- **Tree shapes**

| Shape | Evolves at | Forms | Lines | Species |
|---|---|---|---|---|
| Linear (L) | 16 → 32 | 3 | 18 | 54 |
| Split once (S) | 16 (1 of 2) → 32 | 5 | 22 | 110 |
| Split twice (D) | 8 → 16 (1 of 2) → 32 (1 of 2 per path) | 8 | 6 | 48 |
| Wide (W) | 16 (1 of 4) → 32 | 9 | 4 | 36 |
| Capstones (C) | 64, from one final form | +1 | 8 | 8 |
| **Total** | | | **50** | **256** |

- **Base-stat-total budget by stage:** base ≈ 300 · first evolution ≈ 420 ·
  second ≈ 500 · third ≈ 540 · capstone ≈ 600. Starter lines sit ~5% under
  budget at every stage.
- **Types:** base forms are single-typed; evolutions may add a second type
  (max 2). Every type is the base type of 3 lines; Kernel and Null have 4.
- **Requirements:** `—` means none beyond level. *Hidden* requirements show as
  `???` in the Codex until someone first meets them (first-discovery
  announcement, name recorded), then become public.
- **Roles** (stat identity): *sweeper* (Attack/Speed), *nuker* (Focus),
  *tank* (HP/Defense/Resolve), *wall* (Resolve), *striker* (Attack/Haste),
  *spammer* (Haste/Energy), *support* (statuses/utility), *scout* (Speed),
  *bruiser* (HP/Attack), *battery* (Energy), *balanced*.

## 2. Requirement vocabulary

| Requirement | Meaning |
|---|---|
| `heldItem X` | holding evolution item X (consumed) |
| `dominantIV S` | stat S has the strictly highest IV |
| `moveTypeUses T n` | has used ≥ n moves of type T (lifetime, tracked per daemon) |
| `subnet N` | evolves while in subnet N |
| `clean` / `signature ≥ k` | image is clean / has at least signature k |
| `originalOperator` | still owned by the operator in its capture log |
| `crashes ≤ n` / `crashes ≥ n` | lifetime crash count |
| `arenaWins n` | ≥ n ranked arena wins while in this operator's RAM |
| `unobserved` | no other operator within 32 tiles at the moment of evolving |

## 3. Evolution items (16, one per type, held and consumed)

| Item | Type | | Item | Type |
|---|---|---|---|---|
| Boot Sector | Kernel | | Void Shard | Null |
| Jumbo Frame | Packet | | Cosmic Ray | Glitch |
| Cipher Key | Crypto | | Onion Layer | Proxy |
| Warm Cache | Cache | | Region Token | Cloud |
| Spinlock | Thread | | Guard Page | Stack |
| Sigmask | Signal | | Arena Chunk | Heap |
| Keepalive | Socket | | Ring Seal | Buffer |
| Dotfile | Shell | | Setuid Bit | Root |

## 4. Subnets referenced

`lo` (starter), `lan`, `dmz`, `backbone`, `darknet`, `cloudnet`, `sandbox`
(arena instances), `kernelspace` (Incidents). Eight subnets; layout is SP3.

## 5. Index

| # | Base | Type | Shape | Notes |
|---|---|---|---|---|
| 01 | Initling | Kernel | D | capstone |
| 02 | Syscub | Kernel | S | |
| 03 | Irqlet | Kernel | L | |
| 04 | Tickling | Kernel | L | |
| 05 | Pingling | Packet | D | starter, capstone |
| 06 | Floodhound | Packet | S | SP1 |
| 07 | Fraglet | Packet | L | |
| 08 | Hashling | Crypto | D | starter, capstone |
| 09 | Cipherbat | Crypto | S | SP1 |
| 10 | Nonceling | Crypto | L | |
| 11 | Hitling | Cache | S | |
| 12 | Missmoth | Cache | L | |
| 13 | Lruk | Cache | L | |
| 14 | Forkling | Thread | W | capstone |
| 15 | Mutexel | Thread | S | |
| 16 | Racecon | Thread | S | |
| 17 | Sigkit | Signal | S | |
| 18 | Hupling | Signal | L | |
| 19 | Trapfly | Signal | L | |
| 20 | Portling | Socket | W | |
| 21 | Bindbug | Socket | S | |
| 22 | Shakelet | Socket | L | |
| 23 | Spillard | Buffer | S | |
| 24 | Ringlet | Buffer | L | |
| 25 | Queuepillar | Buffer | S | |
| 26 | Promptling | Shell | W | |
| 27 | Pipeon | Shell | S | |
| 28 | Globber | Shell | L | |
| 29 | Sudoling | Root | S | |
| 30 | Rootkitten | Root | S | capstone |
| 31 | Chmole | Root | L | |
| 32 | Nullpup | Null | D | starter, capstone |
| 33 | Voidlet | Null | S | SP1 |
| 34 | Sinkling | Null | L | |
| 35 | Nilwisp | Null | L | |
| 36 | Glitchmite | Glitch | D | starter |
| 37 | Bitrot | Glitch | S | SP1 |
| 38 | Heisenbug | Glitch | S | capstone |
| 39 | Maskling | Proxy | W | |
| 40 | Relayven | Proxy | S | |
| 41 | Tunnelope | Proxy | L | |
| 42 | Cirrusync | Cloud | D | |
| 43 | Lambkin | Cloud | S | |
| 44 | Nimbyte | Cloud | L | |
| 45 | Framelet | Stack | S | |
| 46 | Recursel | Stack | L | |
| 47 | Stackrab | Stack | L | capstone |
| 48 | Mallocub | Heap | S | |
| 49 | Leakling | Heap | S | |
| 50 | Garbadger | Heap | S | |

Totals: D 6 · W 4 · S 22 · L 18 · capstones 8 → 256 species.

## 6. Lines

Columns: **Lv** evolves at · **Form** · **Types** · **From** · **Requirement** ·
**Role**.

### Kernel

**01 · Initling** (D, capstone) — PID 1: the first process, parent of all.

| Lv | Form | Types | From | Requirement | Role |
|---|---|---|---|---|---|
| — | Initling | Kernel | — | — | balanced |
| 8 | Bootlet | Kernel | Initling | — | balanced |
| 16 | Inittab | Kernel/Shell | Bootlet | — | support |
| 16 | Upstarter | Kernel/Signal | Bootlet | `heldItem Sigmask` | spammer |
| 32 | Sysvern | Kernel/Shell | Inittab | — | wall |
| 32 | Runlevion | Kernel/Root | Inittab | `heldItem Setuid Bit` | striker |
| 32 | Systemdra | Kernel/Signal | Upstarter | — | nuker |
| 32 | Launchdrake | Kernel/Cloud | Upstarter | *Hidden:* `subnet cloudnet` | scout |
| 64 | **Pidzero** | Kernel | Systemdra | *Hidden:* `originalOperator` + `crashes ≤ 0` | balanced (capstone) |

**02 · Syscub** (S) — a bear cub that only speaks in syscalls.

| Lv | Form | Types | From | Requirement | Role |
|---|---|---|---|---|---|
| — | Syscub | Kernel | — | — | tank |
| 16 | Trapbear | Kernel | Syscub | — | tank |
| 16 | Ioctlynx | Kernel/Socket | Syscub | `heldItem Keepalive` | scout |
| 32 | Syscallossus | Kernel | Trapbear | — | tank |
| 32 | Ioctalon | Kernel/Socket | Ioctlynx | — | sweeper |

**03 · Irqlet** (L) — an interrupt that cuts in line.

| Lv | Form | Types | From | Requirement | Role |
|---|---|---|---|---|---|
| — | Irqlet | Kernel | — | — | spammer |
| 16 | Interruptor | Kernel/Signal | Irqlet | — | spammer |
| 32 | Nomaskara | Kernel/Signal | Interruptor | — | spammer |

**04 · Tickling** (L) — the scheduler's heartbeat.

| Lv | Form | Types | From | Requirement | Role |
|---|---|---|---|---|---|
| — | Tickling | Kernel | — | — | scout |
| 16 | Jiffox | Kernel | Tickling | — | scout |
| 32 | Schedragon | Kernel/Thread | Jiffox | — | sweeper |

### Packet

**05 · Pingling** (D, starter, capstone) — an ICMP echo chick that chirps back
everything it hears.

| Lv | Form | Types | From | Requirement | Role |
|---|---|---|---|---|---|
| — | Pingling | Packet | — | — | scout |
| 8 | Echolet | Packet | Pingling | — | scout |
| 16 | Tracerat | Packet/Signal | Echolet | — | scout |
| 16 | Broadcaw | Packet | Echolet | `heldItem Jumbo Frame` | nuker |
| 32 | Hopmaster | Packet/Signal | Tracerat | — | sweeper |
| 32 | Pathfinch | Packet/Proxy | Tracerat | `heldItem Onion Layer` | spammer |
| 32 | Multicastor | Packet/Buffer | Broadcaw | — | nuker |
| 32 | Anycastrel | Packet/Cloud | Broadcaw | *Hidden:* `dominantIV Speed` | striker |
| 64 | **Pingodeth** | Packet/Glitch | Hopmaster | *Hidden:* `moveTypeUses Packet 4096` + `subnet backbone` | sweeper (capstone) |

**06 · Floodhound** (S) — a hound that never stops sending SYNs.

| Lv | Form | Types | From | Requirement | Role |
|---|---|---|---|---|---|
| — | Floodhound | Packet | — | — | striker |
| 16 | Synhound | Packet | Floodhound | — | striker |
| 16 | Ackhound | Packet/Socket | Floodhound | `heldItem Keepalive` | balanced |
| 32 | DDoSberman | Packet/Buffer | Synhound | — | striker |
| 32 | Ackerberus | Packet/Socket | Ackhound | — | bruiser |

**07 · Fraglet** (L) — a packet fragment looking for the rest of itself.

| Lv | Form | Types | From | Requirement | Role |
|---|---|---|---|---|---|
| — | Fraglet | Packet | — | — | tank |
| 16 | Reassemblob | Packet/Buffer | Fraglet | — | tank |
| 32 | Jumbeast | Packet/Buffer | Reassemblob | — | bruiser |

### Crypto

**08 · Hashling** (D, starter, capstone) — turns anything it eats into a
fixed-size pellet.

| Lv | Form | Types | From | Requirement | Role |
|---|---|---|---|---|---|
| — | Hashling | Crypto | — | — | balanced |
| 8 | Digestoad | Crypto | Hashling | — | balanced |
| 16 | Saltamander | Crypto | Digestoad | — | wall |
| 16 | Pepperpent | Crypto/Glitch | Digestoad | `heldItem Cosmic Ray` | nuker |
| 32 | Bcryptile | Crypto | Saltamander | — | tank |
| 32 | Argonaut | Crypto/Heap | Saltamander | `heldItem Arena Chunk` | wall |
| 32 | Shadragon | Crypto/Glitch | Pepperpent | — | nuker |
| 32 | Merklion | Crypto/Root | Pepperpent | *Hidden:* `originalOperator` + `arenaWins 16` | bruiser |
| 64 | **Collider** | Crypto/Glitch | Shadragon | *Hidden:* `clean` | nuker (capstone) |

**09 · Cipherbat** (S) — sees only ciphertext, hunts by entropy.

| Lv | Form | Types | From | Requirement | Role |
|---|---|---|---|---|---|
| — | Cipherbat | Crypto | — | — | nuker |
| 16 | Blockbat | Crypto | Cipherbat | — | wall |
| 16 | Streamwing | Crypto/Packet | Cipherbat | `heldItem Jumbo Frame` | scout |
| 32 | Aesferatu | Crypto/Null | Blockbat | — | wall |
| 32 | Chachawing | Crypto/Packet | Streamwing | — | sweeper |

**10 · Nonceling** (L) — never the same twice.

| Lv | Form | Types | From | Requirement | Role |
|---|---|---|---|---|---|
| — | Nonceling | Crypto | — | — | support |
| 16 | Entropix | Crypto | Nonceling | — | support |
| 32 | Chaosigil | Crypto/Glitch | Entropix | — | nuker |

### Cache

**11 · Hitling** (S) — always already there.

| Lv | Form | Types | From | Requirement | Role |
|---|---|---|---|---|---|
| — | Hitling | Cache | — | — | scout |
| 16 | Warmcat | Cache | Hitling | — | sweeper |
| 16 | Prefetchet | Cache/Signal | Hitling | `heldItem Sigmask` | spammer |
| 32 | Hotpanther | Cache | Warmcat | — | sweeper |
| 32 | Prophetch | Cache/Signal | Prefetchet | — | spammer |

**12 · Missmoth** (L) — flutters toward data that isn't there.

| Lv | Form | Types | From | Requirement | Role |
|---|---|---|---|---|---|
| — | Missmoth | Cache | — | — | striker |
| 16 | Pagefaulter | Cache/Kernel | Missmoth | — | striker |
| 32 | Thrashmoth | Cache/Kernel | Pagefaulter | — | striker (glass cannon) |

**13 · Lruk** (L) — a rook that throws out whatever it touched last.

| Lv | Form | Types | From | Requirement | Role |
|---|---|---|---|---|---|
| — | Lruk | Cache | — | — | wall |
| 16 | Evictern | Cache | Lruk | — | wall |
| 32 | Tiercrow | Cache/Buffer | Evictern | — | tank |

### Thread

**14 · Forkling** (W, capstone) — splits into whatever it needs to be.

| Lv | Form | Types | From | Requirement | Role |
|---|---|---|---|---|---|
| — | Forkling | Thread | — | — | balanced |
| 16 | Execdra | Thread/Shell | Forkling | — | striker |
| 16 | Clonewisp | Thread/Glitch | Forkling | `heldItem Cosmic Ray` | spammer |
| 16 | Fibrill | Thread/Stack | Forkling | `heldItem Guard Page` | support |
| 16 | Goroutern | Thread/Cloud | Forkling | *Hidden:* `subnet cloudnet` | scout |
| 32 | Execalibur | Thread/Shell | Execdra | — | striker |
| 32 | Clonestorm | Thread/Glitch | Clonewisp | — | spammer |
| 32 | Corovex | Thread/Stack | Fibrill | — | support |
| 32 | Chanaconda | Thread/Cloud | Goroutern | — | sweeper |
| 64 | **Forkbomb** | Thread/Glitch | Clonestorm | *Hidden:* `subnet kernelspace` + `moveTypeUses Thread 4096` | spammer (capstone) |

**15 · Mutexel** (S) — a weasel that won't let go of what it holds.

| Lv | Form | Types | From | Requirement | Role |
|---|---|---|---|---|---|
| — | Mutexel | Thread | — | — | tank |
| 16 | Lockstoat | Thread | Mutexel | — | tank |
| 16 | Semaferret | Thread/Signal | Mutexel | `heldItem Sigmask` | support |
| 32 | Deadlockodile | Thread/Null | Lockstoat | — | tank |
| 32 | Monitaur | Thread/Signal | Semaferret | — | bruiser |

**16 · Racecon** (S) — steals your data between check and use.

| Lv | Form | Types | From | Requirement | Role |
|---|---|---|---|---|---|
| — | Racecon | Thread | — | — | scout |
| 16 | Dataracer | Thread | Racecon | — | sweeper |
| 16 | Toctoucan | Thread/Glitch | Racecon | `heldItem Cosmic Ray` | support |
| 32 | Hazardash | Thread | Dataracer | — | sweeper |
| 32 | Timewarbler | Thread/Glitch | Toctoucan | — | support |

### Signal

**17 · Sigkit** (S) — a kitten that ends conversations.

| Lv | Form | Types | From | Requirement | Role |
|---|---|---|---|---|---|
| — | Sigkit | Signal | — | — | striker |
| 16 | Termcat | Signal | Sigkit | — | striker |
| 16 | Sigstop | Signal/Thread | Sigkit | `heldItem Spinlock` | support |
| 32 | Sigkillion | Signal | Termcat | — | striker |
| 32 | Pausepanther | Signal/Thread | Sigstop | — | support |

**18 · Hupling** (L) — hang up on it and it just reloads.

| Lv | Form | Types | From | Requirement | Role |
|---|---|---|---|---|---|
| — | Hupling | Signal | — | — | support |
| 16 | Reloadog | Signal | Hupling | — | support |
| 32 | Respawnd | Signal/Kernel | Reloadog | — | tank |

**19 · Trapfly** (L) — lands exactly where you set the breakpoint.

| Lv | Form | Types | From | Requirement | Role |
|---|---|---|---|---|---|
| — | Trapfly | Signal | — | — | support |
| 16 | Breakpointer | Signal/Stack | Trapfly | — | support |
| 32 | Debugonfly | Signal/Stack | Breakpointer | — | support |

### Socket

**20 · Portling** (W) — waits at a numbered door.

| Lv | Form | Types | From | Requirement | Role |
|---|---|---|---|---|---|
| — | Portling | Socket | — | — | balanced |
| 16 | Httpard | Socket/Cloud | Portling | — | sweeper |
| 16 | Sshark | Socket/Crypto | Portling | `heldItem Cipher Key` | striker |
| 16 | Dnsnake | Socket/Proxy | Portling | `heldItem Onion Layer` | support |
| 16 | Smtpelican | Socket/Packet | Portling | *Hidden:* `dominantIV Energy` | battery |
| 32 | Quicheetah | Socket/Cloud | Httpard | — | sweeper |
| 32 | Greatsshark | Socket/Crypto | Sshark | — | striker |
| 32 | Resolviper | Socket/Proxy | Dnsnake | — | support |
| 32 | Spamatross | Socket/Packet | Smtpelican | — | battery |

**21 · Bindbug** (S) — claims a port and never leaves.

| Lv | Form | Types | From | Requirement | Role |
|---|---|---|---|---|---|
| — | Bindbug | Socket | — | — | wall |
| 16 | Listenbug | Socket | Bindbug | — | wall |
| 16 | Connectick | Socket/Packet | Bindbug | `heldItem Jumbo Frame` | striker |
| 32 | Acceptarantula | Socket | Listenbug | — | tank |
| 32 | Streamantis | Socket/Packet | Connectick | — | striker |

**22 · Shakelet** (L) — greets everyone three times.

| Lv | Form | Types | From | Requirement | Role |
|---|---|---|---|---|---|
| — | Shakelet | Socket | — | — | balanced |
| 16 | Synackle | Socket | Shakelet | — | balanced |
| 32 | Tlsamurai | Socket/Crypto | Synackle | — | bruiser |

### Buffer

**23 · Spillard** (S) — a lizard that writes past the end.

| Lv | Form | Types | From | Requirement | Role |
|---|---|---|---|---|---|
| — | Spillard | Buffer | — | — | striker |
| 16 | Smashgecko | Buffer | Spillard | — | striker |
| 16 | Spraygon | Buffer/Heap | Spillard | `heldItem Arena Chunk` | nuker |
| 32 | Smashagator | Buffer/Stack | Smashgecko | — | bruiser |
| 32 | Sprayvern | Buffer/Heap | Spraygon | — | nuker |

**24 · Ringlet** (L) — chases its own tail forever.

| Lv | Form | Types | From | Requirement | Role |
|---|---|---|---|---|---|
| — | Ringlet | Buffer | — | — | battery |
| 16 | Wrapsnake | Buffer | Ringlet | — | battery |
| 32 | Ourobyte | Buffer | Wrapsnake | — | battery |

**25 · Queuepillar** (S) — first in, first out, first to become a butterfly.

| Lv | Form | Types | From | Requirement | Role |
|---|---|---|---|---|---|
| — | Queuepillar | Buffer | — | — | tank |
| 16 | Queuepa | Buffer | Queuepillar | — | wall |
| 16 | Brokerpa | Buffer/Cloud | Queuepillar | `heldItem Region Token` | support |
| 32 | Priorifly | Buffer | Queuepa | — | nuker |
| 32 | Streamoth | Buffer/Cloud | Brokerpa | — | support |

### Shell

**26 · Promptling** (W) — blinks patiently, waiting for input.

| Lv | Form | Types | From | Requirement | Role |
|---|---|---|---|---|---|
| — | Promptling | Shell | — | — | balanced |
| 16 | Bashog | Shell | Promptling | — | bruiser |
| 16 | Zshrike | Shell/Signal | Promptling | `heldItem Dotfile` | spammer |
| 16 | Fishell | Shell/Cache | Promptling | `heldItem Warm Cache` | support |
| 16 | Pwshrew | Shell/Cloud | Promptling | *Hidden:* `dominantIV Resolve` | wall |
| 32 | Bashemoth | Shell | Bashog | — | bruiser |
| 32 | Zshraptor | Shell/Signal | Zshrike | — | spammer |
| 32 | Leviafish | Shell/Cache | Fishell | — | support |
| 32 | Objectaur | Shell/Cloud | Pwshrew | — | wall |

**27 · Pipeon** (S) — carries output to whoever's next.

| Lv | Form | Types | From | Requirement | Role |
|---|---|---|---|---|---|
| — | Pipeon | Shell | — | — | scout |
| 16 | Teegull | Shell | Pipeon | — | support |
| 16 | Fifowl | Shell/Buffer | Pipeon | `heldItem Ring Seal` | battery |
| 32 | Xargoyle | Shell | Teegull | — | striker |
| 32 | Streamowl | Shell/Buffer | Fifowl | — | battery |

**28 · Globber** (L) — matches anything, keeps everything.

| Lv | Form | Types | From | Requirement | Role |
|---|---|---|---|---|---|
| — | Globber | Shell | — | — | support |
| 16 | Wildcardinal | Shell | Globber | — | support |
| 32 | Regexolotl | Shell/Glitch | Wildcardinal | — | nuker |

### Root

**29 · Sudoling** (S) — asks nicely, then does it anyway.

| Lv | Form | Types | From | Requirement | Role |
|---|---|---|---|---|---|
| — | Sudoling | Root | — | — | striker |
| 16 | Sudoer | Root | Sudoling | — | striker |
| 16 | Suidhawk | Root/Shell | Sudoling | `heldItem Dotfile` | sweeper |
| 32 | Superuserpent | Root | Sudoer | — | striker |
| 32 | Visudoe | Root/Shell | Suidhawk | — | sweeper |

**30 · Rootkitten** (S, capstone) — hides under the process list.

| Lv | Form | Types | From | Requirement | Role |
|---|---|---|---|---|---|
| — | Rootkitten | Root | — | — | scout |
| 16 | Hookat | Root | Rootkitten | — | support |
| 16 | Bootkit | Root/Kernel | Rootkitten | `heldItem Boot Sector` | bruiser |
| 32 | Rootkitsune | Root | Hookat | — | support |
| 32 | Firmwarg | Root/Kernel | Bootkit | — | bruiser |
| 64 | **Ringminus** | Root/Kernel | Firmwarg | *Hidden:* `subnet kernelspace` + `dominantIV Attack` | striker (capstone) |

**31 · Chmole** (L) — digs in and changes who's allowed in.

| Lv | Form | Types | From | Requirement | Role |
|---|---|---|---|---|---|
| — | Chmole | Root | — | — | wall |
| 16 | Umaskunk | Root | Chmole | — | support |
| 32 | Aclpaca | Root/Shell | Umaskunk | — | wall |

### Null

**32 · Nullpup** (D, starter, capstone) — fetches nothing, proudly.

| Lv | Form | Types | From | Requirement | Role |
|---|---|---|---|---|---|
| — | Nullpup | Null | — | — | balanced |
| 8 | Nullhound | Null | Nullpup | — | balanced |
| 16 | Undefido | Null | Nullhound | — | tank |
| 16 | Nanwolf | Null/Glitch | Nullhound | `heldItem Cosmic Ray` | striker |
| 32 | Maybemastiff | Null | Undefido | — | tank |
| 32 | Tombstag | Null/Heap | Undefido | `heldItem Arena Chunk` | wall |
| 32 | Infinitwolf | Null/Glitch | Nanwolf | — | sweeper |
| 32 | Segfang | Null/Kernel | Nanwolf | *Hidden:* `crashes ≥ 64` | striker |
| 64 | **Derefiend** | Null/Kernel | Segfang | *Hidden:* `originalOperator` + `subnet darknet` | striker (capstone) |

**33 · Voidlet** (S) — a small patch of absence.

| Lv | Form | Types | From | Requirement | Role |
|---|---|---|---|---|---|
| — | Voidlet | Null | — | — | wall |
| 16 | Voidwisp | Null | Voidlet | — | wall |
| 16 | Blackholet | Null/Cloud | Voidlet | `heldItem Region Token` | nuker |
| 32 | Voidmaw | Null | Voidwisp | — | tank |
| 32 | Horizoneel | Null/Cloud | Blackholet | — | nuker |

**34 · Sinkling** (L) — /dev/null with legs.

| Lv | Form | Types | From | Requirement | Role |
|---|---|---|---|---|---|
| — | Sinkling | Null | — | — | tank |
| 16 | Bitbucketoad | Null | Sinkling | — | tank |
| 32 | Nulliathan | Null/Buffer | Bitbucketoad | — | tank |

**35 · Nilwisp** (L) — there, then not.

| Lv | Form | Types | From | Requirement | Role |
|---|---|---|---|---|---|
| — | Nilwisp | Null | — | — | scout |
| 16 | Nilshade | Null | Nilwisp | — | scout |
| 32 | Nilphantom | Null/Proxy | Nilshade | — | sweeper |

### Glitch

**36 · Glitchmite** (D, starter) — a tiny flipped bit with big ambitions.

| Lv | Form | Types | From | Requirement | Role |
|---|---|---|---|---|---|
| — | Glitchmite | Glitch | — | — | striker |
| 8 | Bitflea | Glitch | Glitchmite | — | striker |
| 16 | Corruptoad | Glitch | Bitflea | — | bruiser |
| 16 | Tearwyrm | Glitch/Signal | Bitflea | `heldItem Sigmask` | spammer |
| 32 | Corruptitan | Glitch | Corruptoad | — | bruiser |
| 32 | Checksumander | Glitch/Crypto | Corruptoad | `heldItem Cipher Key` | wall |
| 32 | Flickerwyrm | Glitch/Signal | Tearwyrm | — | spammer |
| 32 | Artifactopus | Glitch/Cache | Tearwyrm | *Hidden:* `dominantIV Haste` | nuker |

**37 · Bitrot** (S) — slow decay you only notice too late.

| Lv | Form | Types | From | Requirement | Role |
|---|---|---|---|---|---|
| — | Bitrot | Glitch | — | — | support |
| 16 | Rotgrub | Glitch | Bitrot | — | support |
| 16 | Sectoroach | Glitch/Buffer | Bitrot | `heldItem Ring Seal` | tank |
| 32 | Decaypede | Glitch | Rotgrub | — | support |
| 32 | Fsckroach | Glitch/Buffer | Sectoroach | — | tank |

**38 · Heisenbug** (S, capstone) — changes when you look at it.

| Lv | Form | Types | From | Requirement | Role |
|---|---|---|---|---|---|
| — | Heisenbug | Glitch | — | — | scout |
| 16 | Quantibug | Glitch | Heisenbug | — | scout |
| 16 | Bohrbug | Glitch/Stack | Heisenbug | `heldItem Guard Page` | tank |
| 32 | Superposibug | Glitch | Quantibug | — | sweeper |
| 32 | Mandelbug | Glitch/Stack | Bohrbug | — | wall |
| 64 | **Schrodibug** | Glitch/Null | Superposibug | *Hidden:* `unobserved` + `signature ≥ 1` | sweeper (capstone) |

### Proxy

**39 · Maskling** (W) — wears someone else's address.

| Lv | Form | Types | From | Requirement | Role |
|---|---|---|---|---|---|
| — | Maskling | Proxy | — | — | balanced |
| 16 | Forwarden | Proxy | Maskling | — | wall |
| 16 | Reverseal | Proxy/Socket | Maskling | `heldItem Keepalive` | tank |
| 16 | Glasswing | Proxy/Null | Maskling | `heldItem Void Shard` | scout |
| 16 | Torchid | Proxy/Crypto | Maskling | *Hidden:* `subnet darknet` | support |
| 32 | Gatewarden | Proxy | Forwarden | — | wall |
| 32 | Loadbalrus | Proxy/Socket | Reverseal | — | tank |
| 32 | Phantomwing | Proxy/Null | Glasswing | — | sweeper |
| 32 | Garlicvine | Proxy/Crypto | Torchid | — | support |

**40 · Relayven** (S) — passes messages it can't read.

| Lv | Form | Types | From | Requirement | Role |
|---|---|---|---|---|---|
| — | Relayven | Proxy | — | — | scout |
| 16 | Hopraven | Proxy | Relayven | — | scout |
| 16 | Tunnelhawk | Proxy/Crypto | Relayven | `heldItem Cipher Key` | striker |
| 32 | Natrook | Proxy | Hopraven | — | support |
| 32 | Wireguardian | Proxy/Crypto | Tunnelhawk | — | bruiser |

**41 · Tunnelope** (L) — runs through walls by wrapping itself in them.

| Lv | Form | Types | From | Requirement | Role |
|---|---|---|---|---|---|
| — | Tunnelope | Proxy | — | — | scout |
| 16 | Encapsulope | Proxy | Tunnelope | — | scout |
| 32 | Vxlantler | Proxy/Packet | Encapsulope | — | sweeper |

### Cloud

**42 · Cirrusync** (D) — drifts between regions, never quite consistent.

| Lv | Form | Types | From | Requirement | Role |
|---|---|---|---|---|---|
| — | Cirrusync | Cloud | — | — | nuker |
| 8 | Cumulink | Cloud | Cirrusync | — | nuker |
| 16 | Stratoswarm | Cloud/Thread | Cumulink | — | spammer |
| 16 | Edgewisp | Cloud/Proxy | Cumulink | `heldItem Onion Layer` | scout |
| 32 | Orchestrix | Cloud/Thread | Stratoswarm | — | support |
| 32 | Shardhive | Cloud/Heap | Stratoswarm | `heldItem Arena Chunk` | tank |
| 32 | Cdnimbus | Cloud/Proxy | Edgewisp | — | nuker |
| 32 | Edgelord | Cloud/Proxy | Edgewisp | *Hidden:* `arenaWins 16` | sweeper |

**43 · Lambkin** (S) — only exists while it's being useful.

| Lv | Form | Types | From | Requirement | Role |
|---|---|---|---|---|---|
| — | Lambkin | Cloud | — | — | spammer |
| 16 | Functram | Cloud | Lambkin | — | spammer |
| 16 | Triggoat | Cloud/Signal | Lambkin | `heldItem Sigmask` | support |
| 32 | Ephemeram | Cloud | Functram | — | striker |
| 32 | Cronghorn | Cloud/Signal | Triggoat | — | support |

**44 · Nimbyte** (L) — a small cloud carrying a small charge.

| Lv | Form | Types | From | Requirement | Role |
|---|---|---|---|---|---|
| — | Nimbyte | Cloud | — | — | nuker |
| 16 | Stratobyte | Cloud | Nimbyte | — | nuker |
| 32 | Stormbyte | Cloud/Signal | Stratobyte | — | nuker |

### Stack

**45 · Framelet** (S) — pushed on, popped off, never complains.

| Lv | Form | Types | From | Requirement | Role |
|---|---|---|---|---|---|
| — | Framelet | Stack | — | — | balanced |
| 16 | Calleel | Stack | Framelet | — | striker |
| 16 | Tracebeetle | Stack/Signal | Framelet | `heldItem Sigmask` | support |
| 32 | Returnado | Stack | Calleel | — | striker |
| 32 | Coredrake | Stack/Signal | Tracebeetle | — | nuker |

**46 · Recursel** (L) — contains a smaller Recursel.

| Lv | Form | Types | From | Requirement | Role |
|---|---|---|---|---|---|
| — | Recursel | Stack | — | — | spammer |
| 16 | Tailcaller | Stack | Recursel | — | spammer |
| 32 | Fractalisk | Stack/Glitch | Tailcaller | — | nuker |

**47 · Stackrab** (L, capstone) — carries everything it owns on its back.

| Lv | Form | Types | From | Requirement | Role |
|---|---|---|---|---|---|
| — | Stackrab | Stack | — | — | tank |
| 16 | Popcrab | Stack | Stackrab | — | tank |
| 32 | Hermistack | Stack/Buffer | Popcrab | — | tank |
| 64 | **Stackoverlord** | Stack/Buffer | Hermistack | *Hidden:* `moveTypeUses Stack 4096` + `heldItem Guard Page` | bruiser (capstone) |

### Heap

**48 · Mallocub** (S) — grabs more than it needs.

| Lv | Form | Types | From | Requirement | Role |
|---|---|---|---|---|---|
| — | Mallocub | Heap | — | — | bruiser |
| 16 | Brkbear | Heap | Mallocub | — | bruiser |
| 16 | Slabear | Heap/Kernel | Mallocub | `heldItem Boot Sector` | tank |
| 32 | Mmapmammoth | Heap | Brkbear | — | bruiser |
| 32 | Slabgrizzly | Heap/Kernel | Slabear | — | tank |

**49 · Leakling** (S) — grows a little every time you forget it.

| Lv | Form | Types | From | Requirement | Role |
|---|---|---|---|---|---|
| — | Leakling | Heap | — | — | tank |
| 16 | Leakslug | Heap | Leakling | — | tank |
| 16 | Danglerfish | Heap/Null | Leakling | `heldItem Void Shard` | striker |
| 32 | Bloatwhale | Heap | Leakslug | — | tank |
| 32 | Wildangler | Heap/Null | Danglerfish | — | striker |

**50 · Garbadger** (S) — cleans up after everyone, eventually.

| Lv | Form | Types | From | Requirement | Role |
|---|---|---|---|---|---|
| — | Garbadger | Heap | — | — | support |
| 16 | Sweepbadger | Heap | Garbadger | — | support |
| 16 | Genbadger | Heap/Thread | Garbadger | `heldItem Spinlock` | spammer |
| 32 | Compactaur | Heap | Sweepbadger | — | tank |
| 32 | Haltverine | Heap/Thread | Genbadger | — | striker |

## 7. Capstones

| Capstone | Line | From | Requirement (hidden) |
|---|---|---|---|
| Pidzero | Initling | Systemdra | `originalOperator` + `crashes ≤ 0` |
| Pingodeth | Pingling | Hopmaster | `moveTypeUses Packet 4096` + `subnet backbone` |
| Collider | Hashling | Shadragon | `clean` |
| Forkbomb | Forkling | Clonestorm | `subnet kernelspace` + `moveTypeUses Thread 4096` |
| Ringminus | Rootkitten | Firmwarg | `subnet kernelspace` + `dominantIV Attack` |
| Derefiend | Nullpup | Segfang | `originalOperator` + `subnet darknet` |
| Schrodibug | Heisenbug | Superposibug | `unobserved` + `signature ≥ 1` |
| Stackoverlord | Stackrab | Hermistack | `moveTypeUses Stack 4096` + `heldItem Guard Page` |

## 8. Notes for SP3

- Names are playful references to real software concepts; before public
  launch, sweep them for collisions with existing trademarks.
- Tracking needed per daemon for requirements: `moveTypeUses` (16 counters),
  `crashes`, `arenaWins`. SP1's `Daemon` table gains these columns in SP3.
- A validation test asserts the counts in §1: 50 lines, 256 species, every
  form reachable, every `From` exists, evolution levels ∈ {8, 16, 32, 64},
  no species has more than 2 types.
