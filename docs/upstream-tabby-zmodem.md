# Tabby: ZMODEM detection is the largest single cost in the terminal pipeline

**Affects:** Tabby 1.0.235, `tabby-terminal`
**Impact:** ~10% of renderer CPU under load, in every terminal tab, whether or not ZMODEM is ever used.

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

and `ZModemDecorator` feeds it in 1 KB slices:

```js
const chunkSize = 1024
for (let i = 0; i <= Math.floor(data.length / chunkSize); i++) {
  this.sentry.consume(Buffer.from(data.slice(...)))
}
```

So every megabyte of terminal output becomes ~1M boxed array elements,
scanned for a ZRINIT/ZRQINIT header, then discarded.

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
