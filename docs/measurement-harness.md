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

## Never match processes with a self-matching pattern

`pgrep -f tabby`, `pkill -f tabby/app.asar` and `pgrep -f "seq 1 900000"` all
match the shell command running them. This killed the measuring shell three
times and reported phantom generator processes once. Read `/proc/*/cmdline`
and skip `$$`.
