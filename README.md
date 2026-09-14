# tabby-ghostty-frontend

A [Tabby](https://tabby.sh) plugin that adds a terminal tab rendered by **Ghostty's VT engine**, via [`ghostty-web`](https://github.com/coder/ghostty-web) (Ghostty compiled to WebAssembly).

Instead of xterm.js's hand-written JavaScript terminal emulation, escape sequences are parsed by the same battle-tested Zig code that runs the native Ghostty app.

## Why a separate tab type, and not a replacement frontend

Tabby has a clean `Frontend` abstraction (`tabby-terminal`), and at first glance the right move is to register a third frontend alongside `xterm` and `xterm-webgl`. That turns out to be impossible from a plugin.

`BaseTerminalTabComponent.ngOnInit` picks its frontend from a hardcoded object literal:

```ts
const cls: new (..._) => Frontend = {
    xterm: XTermFrontend,
    'xterm-webgl': XTermWebGLFrontend,
}[this.config.store.terminal.frontend] ?? XTermFrontend
this.frontend = new cls(this.injector)
```

There is no provider token and no registration hook, so no plugin can contribute a frontend under a new config name — and subclassing `BaseTerminalTabComponent` inherits the same hardcoded lookup.

This plugin therefore ships its **own tab type** extending `BaseTabComponent`, owning a `ghostty-web` terminal directly. Tabby's existing tabs are untouched.

## Status

Experimental. `ghostty-web` is pre-1.0 and was written for [Mux](https://github.com/coder/mux); its xterm.js API compatibility is good but not complete.

Known gaps compared to Tabby's xterm frontend:

- **No search panel** — `ghostty-web` has no serialize/search addon, so find-in-terminal is unavailable.
- **No session restore of scrollback** — recovery restores the working directory and launches a fresh shell.
- **Local shell only** — SSH/serial/telnet profiles still use Tabby's own tabs.
- Tabby's terminal *decorators* and terminal context-menu providers do not apply, since those are wired to `BaseTerminalTabComponent`.

## Requirements

- Tabby 1.0.197+ (developed against 1.0.235)
- Linux/macOS/Windows — `ghostty-web` is WASM, so no native build is needed

`node-pty` is resolved from Tabby's own runtime rather than bundled, since Tabby already ships a copy compiled against its exact Electron ABI.

## Install

```bash
./install.sh
```

Then restart Tabby. A **Ghostty Terminal** profile appears in the profile list (and in the new-tab dropdown); open it to get a Ghostty-rendered shell.

## Build

```bash
npm install --legacy-peer-deps
npm run build
```

## Architecture

| File | Role |
| --- | --- |
| `src/ghostty.session.ts` | `BaseSession` subclass driving a `node-pty` PTY |
| `src/ghostty.tab.component.ts` | `BaseTabComponent` subclass hosting the `ghostty-web` terminal |
| `src/ghostty.profile.ts` | `ProfileProvider` + `TabRecoveryProvider` |
| `src/index.ts` | NgModule wiring the providers |

## License

MIT
