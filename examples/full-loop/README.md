# full-loop

`full-loop.js` is a personal operator script that runs the whole game loop. It is one plain-JavaScript ES module
with no imports. Paste it into the web client's **Script** tab and press Run. It runs in the sandboxed worker and
uses only the public SDK it receives as `game`. Its output goes to the **Log** tab.

## What it does

The script sends one operator command at a time. When the server refuses a command, the script logs the refusal
and waits before trying that action again, so it never retries in a tight loop. On each tick it does the first of
these that applies:

1. **Dodge:** on a `telegraph` blast it moves the operator and its daemons out of the circle.
2. **Evolve:** it evolves any RAM daemon whose evolution is `met` and whose level is reached. If that daemon is
   running, it recalls it first, once it is out of combat.
3. **Host upkeep:** it walks to the subnet host when there is host work and does that work there:
   - accept today's open `clear` and `capture` tickets (at most 2 open, 8 a day);
   - when RAM is full (8/8), `store` the lowest-level duplicates. It keeps the best daemon of each species and never
     stores a running daemon;
   - `restoreAll` when daemons have crashed and there is no `restore` item (with one, it uses `useRestore` in place);
   - buy sniff and tap up to `TOOL_FLOOR` each while bits allow.
4. **Travel:** this happens when `TRAVEL` is on and the best RAM daemon meets the next gateway's level. The route
   is lo → lan → dmz → backbone → darknet → cloudnet, and cloudnet is reached through backbone. The script walks onto
   the gateway, recalls its running daemons and travels. It never uses the Incident gateway to kernelspace.
5. **Run:** it keeps two daemons running, the highest-level healthy ones, and respects `swapReadyTick`.
6. **Fight and capture:** it walks to within 3 tiles of the nearest wild daemon that no other operator has tagged.
   The daemons attack with `bestMoveAgainst`. Below `CAPTURE_HP_PCT` the daemons hold fire, and the operator
   captures with the best tool held (dump > mirror > tap > sniff). It answers every challenge family, single and
   chained. A chain's second stage is unsealed with `crypto.subtle`.

Once the Disk is full (a `Disk is full` / `RAM and Disk are full` refusal) and RAM is full too, it stops capturing
and only fights. A status line is logged every 30 s, along with events such as captures, level-ups, evolutions,
tickets, bits and travel.

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
