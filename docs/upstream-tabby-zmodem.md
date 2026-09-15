# Tabby: ZMODEM detection is the largest single cost in the terminal pipeline

**Affects:** Tabby 1.0.235, `tabby-terminal`
**Impact:** up to ~28% of renderer CPU under load, in every terminal tab,
whether or not ZMODEM is ever used. The renderer's frame loop collapses from
144 Hz idle to ~11 Hz while streaming.

## Measurement

45 s CPU profile of the Tabby renderer, 283,646 samples, streaming
`journalctl --no-pager` into a local tab:

| self time | | function |
|---|---|---|
| **10.2%** | 4,625 ms | `consume` (bundled ZMODEM sentry) |
| 3.2% | 1,455 ms | `parseCellsIntoPool` (renderer cell decode) |
| 2.2% | 1,012 ms | `fillText` (all glyph painting) |

ZMODEM detection costs ~3x the renderer's own cell decoding and ~4.5x all
glyph painting.

## Cause

`consume()` boxes its input into a plain JS `Array`:

```js
consume(input) {
  if (!(input instanceof Array)) {
    input = Array.prototype.slice.call(new Uint8Array(input))
  }
```

*Correction: an earlier draft of this report said `ZModemDecorator` feeds
`consume()` in 1 KB slices. That is not what this build does, and I could not
find any such chunking in it.* `ZModemMiddleware.feedFromSession` passes each
session chunk straight through:

```js
feedFromSession(data) {
  if (this.isActive || this.activeSession) { this.sentry.consume(data) }
  else { this.sentry.consume(data) }        // routes back via to_terminal
}
```

The cost is the boxing inside `consume()` itself: every chunk of terminal
output is copied into a plain JS `Array`, one element per byte, scanned for a
ZRINIT/ZRQINIT header, then discarded.

## Measured again in a stock xterm tab

The first measurement (10.2% self time) was taken in a tab rendered by a
third-party frontend. Repeating it in a **stock xterm.js tab**, streaming
`journalctl --no-pager` for 20 s:

| self time | | function |
|---|---|---|
| 34.7% | 7,058 ms | `(program)` (native/GPU) |
| **28.4%** | **5,773 ms** | **`consume`** (ZMODEM sentry) |
| 3.3% | 675 ms | `restore` |
| 3.0% | 609 ms | `drawImage` |
| 2.6% | 533 ms | `print` (xterm parser) |

`consume` costs more than xterm's own parsing, cell writes and painting
combined. Over the same run the renderer's animation-frame loop fell from
144 Hz while idle to **~11 Hz** under load, so the frame budget is gone
before anything is drawn.

`ZModemDecorator` is registered unconditionally
(`{ provide: TerminalDecorator, useClass: ZModemDecorator, multi: true }`)
and its `attach()` has no setting check, so every terminal pays this.

## Isolated microbenchmark

Scanning 64 MB with the sentry's own pattern - box each slice into a JS
`Array` via `Array.prototype.slice.call(new Uint8Array(input))`, then scan:

| approach | time | throughput | |
|---|---|---|---|
| boxed array per chunk (what Tabby does) | 3,942 ms | 16.2 MB/s | baseline |
| identical scan, no boxing | 55 ms | 1,162.9 MB/s | **71.6x faster** |
| `indexOf` prefilter for the ZDLE header | 7 ms | 8,611.3 MB/s | **530x faster** |

At the 5.2 MB/s that `journalctl` actually streams, the boxed path burns
**~320 ms of CPU per second of output** - roughly a third of the main thread,
spent looking for a file-transfer header that is not there.

## Effect on throughput

Same machine, same workload:

| | throughput | blocked on drain |
|---|---|---|
| native Ghostty | 44.2 MB/s | — |
| Tabby | 5.3 MB/s | 98.8% |

## After removing the middleware

`session.middleware` is a public `SessionMiddlewareStack` with a public
`remove()`, so the entry can be taken out per session:

| | before | after |
|---|---|---|
| `renderMs` p90 | 15.6 ms | 0.2 ms |
| `frameGapMs` p90 | 98.2 ms | 7.2 ms |
| `consume` | 4,625 ms | absent from profile |

## Suggested fixes

1. **Scan without boxing.** Operate on the `Uint8Array`/`Buffer` directly
   instead of `Array.prototype.slice.call`. This alone should remove most of
   the cost.
2. **Don't scan every byte.** A ZMODEM header only appears after `**\x18B`;
   a cheap `indexOf` prefilter would skip virtually all output.
3. **Make it optional.** Expose a setting to disable ZMODEM detection for
   users who never use `rz`/`sz`.

Any one of these recovers the ~10%.
