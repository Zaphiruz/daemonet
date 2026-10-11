# full-loop

`full-loop.js` is a personal operator script that runs the whole game loop. It is one plain-JavaScript ES module
with no imports. Paste it into the web client's **Script** tab and press Run. It runs in the sandboxed worker and
uses only the public SDK it receives as `game`. Its output goes to the **Log** tab.

## What it does

The script sends one operator command at a time. When the server refuses a command, the script logs the refusal
and waits before trying that action again: 2 s at first, doubling with each refusal in a row up to 60 s. It never
retries in a tight loop, and it does not walk to the host for work whose retry is still waiting. On each tick it does the first of
these that applies:

1. **Dodge:** on a `telegraph` blast it moves the operator and its daemons out of the circle.
2. **Evolve:** it evolves any RAM daemon whose evolution is `met` and whose level is reached. If that daemon is
   running, it recalls it first, once it is out of combat.
3. **Host upkeep:** it walks to the subnet host when there is host work and does that work there:
   - accept today's open `clear` and `capture` tickets (at most 2 open, 8 a day);
   - when RAM is full (8/8), `store` the lowest-level duplicates. It keeps the best daemon of each species and never
     stores a running daemon;
   - `restoreAll` when daemons have crashed and there is no `restore` item (with one, it uses `useRestore` in place);
   - buy sniff first, then tap, up to `TOOL_FLOOR` each while bits allow. `restoreAll` also tops sniff up to 8
     (`apps/sim/src/core/systems/upkeep.ts`), so `TOOL_FLOOR` mostly matters for tap.
4. **Travel:** this happens when `TRAVEL` is on and the best RAM daemon meets the next gateway's level. The route
   is lo → lan → dmz → backbone → darknet → cloudnet, and cloudnet is reached through backbone. The script walks onto
   the gateway, recalls its running daemons and travels. It never uses the Incident gateway to kernelspace.
5. **Run:** it keeps two daemons running, the highest-level healthy ones, and respects `swapReadyTick`.
6. **Fight and capture:** it walks to within 3 tiles of the nearest wild daemon that no other operator has tagged.
   The daemons attack with `bestMoveAgainst`. Below `CAPTURE_HP_PCT` the daemons hold fire, and the operator
   captures with the cheapest tool held whose range covers the distance. That is usually sniff (32 bits, range 4).
   It uses tap, mirror or dump only when sniff is out of range or not held. The solvers answer every family at any
   noise and size, single and chained, so a dearer tool buys nothing else. A chain's second stage is unsealed with
   `crypto.subtle`.
   After a failed capture the target is hardened for about 8 s, and a territorial one hits back. So the script
   leaves that target to the daemons for 136 ticks before it tries to capture it again.

Once the Disk is full (a `Disk is full` / `RAM and Disk are full` refusal) and RAM is full too, it stops capturing
and only fights.

## Logging and the 500-line budget

The sandbox lets a script send only **500 log lines in its whole lifetime**, and the budget is never refilled. Once
it is spent the Log tab stays silent. The script saves lines in these ways:

- Command acks are silent.
- Every 30 s it writes one status line: subnet, running daemons, RAM n/8, best level, Disk, bits (and bits earned),
  tools, and counters for captures, failures, level-ups, evolutions and tickets. The line also shows how many log
  lines have been used and how many were muted.
- Event lines are capped at `EVENT_LINES_PER_WINDOW` (4) per 30 s window. Event lines cover refusals, capture
  results, travel, evolutions and tickets; the rest are counted as muted. Bits and level-ups go only into the status
  line.
- With 50 lines left, event lines stop and the status line drops to every 5 minutes.

At worst that is 5 lines per 30 s, so a busy session keeps logging for about 45 minutes. After that only a rare
status line is written. Restart the script to get a fresh budget.

## Knobs (top of the file)

| Knob | Default | Meaning |
| --- | --- | --- |
| `TRAVEL` | `true` | Climb the subnets when strong enough. |
| `SPEND_BITS` | `true` | Buy capture tools at the host. |
| `TOOL_FLOOR` | `3` | Keep at least this many sniff and this many tap. |
| `CAPTURE_HP_PCT` | `0.35` | HP fraction below which a capture starts. |

## Tests

```bash
pnpm exec vitest run examples/full-loop
```

`test/solvers.test.ts` creates challenges of every family with `@daemonet/rules`: noise 0/1/2, sizes 8 to 1024,
single challenges and chains for every ordered pair of families. Each answer must pass `checkAnswer`. The file
also tests the loop's pure helpers. `test/loop.test.ts` drives `main` against a fake client.
