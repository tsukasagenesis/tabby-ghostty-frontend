# Measuring this plugin without fooling yourself

Several rounds of measurement in this project produced confident, wrong
numbers. This records what invalidated them, so the next person does not
repeat it.

## Always gate on requestAnimationFrame first

A detached test window under Wayland reported `document.hidden: false` and
`visibilityState: "visible"` while rAF was **completely suspended** - 0 ticks
in 3 s, against 60 `setInterval` ticks in the same window.

Under that condition the plugin appeared to have a severe bug:

```
flow control blocked for 24 of 27 s
watchdog releases: 11
throughput: 0.47 MB/s
painted frames: 6 in 30 s
```

All of it was an artefact. Re-measured on a window with working rAF, the same
build and the same config gave **0 stalls** and **13-15 MB/s**. Neither
`document.hidden` nor `visibilityState` is a usable liveness guard.

`scratchpad/rafgate.mjs` exits non-zero unless rAF ticks > 30 in 3 s. Run it
before any measurement and refuse to report numbers if it fails.

Launch the test instance so rAF actually runs:

```
--ozone-platform=x11 --disable-background-timer-throttling
--disable-renderer-backgrounding --disable-backgrounding-occluded-windows
```

## Isolate the instance

`TABBY_CONFIG_DIRECTORY` sets the config dir; the plugin search path is
`join(app.getPath('userData'), 'plugins')`, so with `--user-data-dir=$UDD`
the plugin must be at `$UDD/plugins/node_modules/`. Tabby's single-instance
lock will silently hand a relaunch off to an existing process and discard the
new flags - kill all PIDs for that user-data-dir and remove `Singleton*`
first, then verify the flags landed in `/proc/<pid>/cmdline`.

The perf snapshot path honours `TABBY_CONFIG_DIRECTORY` for this reason: two
instances sharing one file produced a capture that looked like a live load
test but was another process's idle terminal.

## Sample at the data's resolution

The snapshot is rewritten every 3 s. Polling faster just re-reads it, which
makes throughput look like a flat staircase. Sample on the 3 s boundary and
key off the `at` timestamp.

## Verify bytes actually moved

Four "load tests" measured an idle terminal. Causes, in order of discovery:
the keystrokes went into a connection picker; `Input.insertText` needs a
focused DOM field and the canvas has `tabIndex: -1`; the load command
completed in under one sampling window. Click the canvas, then focus the
`textarea` (that is where a terminal reads keys), and assert `write.mb`
increased before reporting anything.

Synthetic typing is not the problem: `$(...)`, parentheses, `${}` and pipes
all survive per-character `Input.dispatchKeyEvent`. That was verified with a
probe command, after being wrongly blamed twice.

## Never install a second rAF loop without cancelling the first

A sampler that does this:

```js
window.__n = 0
const tick = () => { window.__n++; requestAnimationFrame(tick) }
requestAnimationFrame(tick)
```

leaks a loop on every call. Sample it repeatedly in one page and the counts
add up, because none of the earlier loops ever stopped. That produced this
sequence of "measurements" on a 143.87 Hz display:

```
slice 1: 116.0 fps
slice 2: 275.0 fps
slice 3: 393.0 fps
slice 4: 558.0 fps
slice 5: 682.5 fps
slice 6: 777.0 fps
```

and a "terminal canvas hidden: 280.5 fps" result that briefly looked like a
major finding about compositing. All of it was the same bug.

The sanity check is free and catches it instantly: **a reading above the
monitor's refresh rate is not a result, it is a broken instrument.** Print the
ceiling next to every number.

`scratchpad/fpslib.mjs` holds the fixed version: it cancels any existing handle
before arming, and cancels again when read.

## Prove the thing under test is actually happening

Four "load tests" in this project measured an idle terminal, and one comparison
nearly shipped with an arm that had no evidence of load at all. A frame-rate
number means nothing without a signal that the workload was running while it was
taken.

Pick the signal to match what the code under test actually does:

- **Canvas terminals** (both xterm and ghostty-web here): hook the 2D context
  methods — and hook *all* of them. A glyph texture atlas blits with
  `drawImage`, so a counter watching only `fillRect` reads ~146 ops while the
  terminal is genuinely drawing ~200,000. That near-zero reading looked like
  proof the stream had died.
- **DOM renderers**: a `MutationObserver` on the rows container. Note that zero
  mutations on a *canvas* terminal is the expected result, not a finding.
- **Throughput**: assert a byte counter advanced between samples.

State the ceiling next to every number, and label each row with whether its
liveness check passed. An unlabelled row invites exactly the mistake of treating
an idle measurement as a result.

## Never match processes with a self-matching pattern

`pgrep -f tabby`, `pkill -f tabby/app.asar` and `pgrep -f "seq 1 900000"` all
match the shell command running them. This killed the measuring shell three
times and reported phantom generator processes once. Read `/proc/*/cmdline`
and skip `$$`.
