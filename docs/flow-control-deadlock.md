# Flow control deadlocks whenever requestAnimationFrame stalls

**Component:** ghostty-web 0.4.0 + this plugin's flow-control path
**Severity:** a stalled rAF stops terminal output permanently

## Mechanism

ghostty-web signals "this write has been painted" by invoking the caller's
callback through rAF:

```js
writeInternal(A, B) {
  this.wasmTerm.write(A); ...; B && requestAnimationFrame(B)
}
```

The plugin's flow control counts outstanding writes and blocks the session
once `fcPending > FC_HIGH`, resuming only when the callback decrements it.
So if rAF stops firing, `fcPending` never drops, `fcBlocked` stays true, and
every later `write()` awaits a promise nobody will resolve. Output stops for
good while the tab still looks alive.

This is the same failure class as the earlier `queue()` deadlock: anything
that depends on rAF alone for liveness will hang when rAF stalls.

## Reproduced

Measured in an isolated Tabby instance, 30 s of streaming:

```
rAF ticks in 3 s : 0        (setInterval ticked 60 times in the same window)
document.hidden  : false    visibilityState: "visible"
flow control     : blocked for 24 of 27 s
watchdog releases: 11
throughput       : 0.47 MB/s, gated by repeated 2 s blocks
painted frames   : 6 in 30 s
```

Note the page reported itself **visible** while rAF was fully suspended, so
`document.hidden` is not a reliable guard.

## Mitigation in this plugin

`armFcWatchdog()` releases the waiters after 2 s, counts the event as
`flowControl.stalls`, and logs it. Briefly ignoring backpressure is a far
better failure than hanging the tab. Verified against the compiled bundle:
11 unit tests covering waiter release, state reset, the stall path, normal
completion and double-arming.

## Suggested upstream fix

Deliver the write callback from a source that cannot be suspended - a
`setTimeout` fallback alongside rAF, or resolve it directly after
`wasmTerm.write()` since the VT state is already updated at that point.
Liveness of the data path should not depend on the compositor scheduling a
frame.

## Caveat on the reproduction

The rAF suspension above was produced by an isolated test window launched
detached under Wayland; it is not proof that this occurs in normal desktop
use. What it does prove is that *if* rAF stalls for any reason - occlusion,
compositor stall, backgrounding - the data path deadlocks. The user-reported
hang matches this signature.
