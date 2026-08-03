# Contributing to ContactDock

This is a small personal open-source tool — contributions are welcome, but please keep changes proportionate to that scope.

## Running locally

Requires [Node.js](https://nodejs.org/) (LTS) and the [Rust toolchain](https://www.rust-lang.org/tools/install). On Windows you'll also need the [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) with the "Desktop development with C++" workload.

```sh
npm install
npm run tauri dev
```

## Filing issues

Open an issue with steps to reproduce (for bugs) or a short description of the use case (for feature requests). Screenshots help.

## Code style

- Frontend is plain HTML/CSS/JS — no framework, no bundler. Keep it that way unless a real need arises.
- Backend (`src-tauri/`) is Rust using only the Tauri APIs needed for local file persistence. Avoid adding dependencies unless necessary.
- No network calls, telemetry, or analytics — this app's entire value proposition is that it's local-only. Any PR that adds outbound network activity will be rejected.
- Prefer small, focused PRs over large rewrites.
