# ContactDock

A local-only desktop contacts manager: vCard import/export, automatic duplicate detection, one-click merge, favorites, and instant search — with everything stored on your own machine and nothing ever sent over the network.

<!-- screenshot: docs/screenshot-list.png -->
<!-- screenshot: docs/screenshot-duplicates.png -->

## Features

- **vCard import/export** — bring in `.vcf` files from any other contacts app (multi-file, folded lines, and `TYPE=` parameters all supported), and export everything back out at any time
- **Duplicate detection** — matches contacts on normalized name, phone, and email using a union-find pass over your contact list
- **One-click and manual merge** — auto-merge a duplicate group, or review matches before combining them
- **Favorites, sorting, and search** — pin the people you contact most, sort by first/last name or recency, and filter instantly as you type
- **Local-only storage** — contacts persist automatically to a JSON file in your OS's app-data folder; no accounts, no cloud sync, no telemetry, no network calls of any kind
- **Data location, always visible** — one click opens the exact folder your data lives in

## Download

Grab the latest installer from the [Releases page](https://github.com/VaibhavHiwale/ContactDock/releases). Windows `.msi` and `.exe` (NSIS) installers are published automatically for every tagged release.

## Building from source

Requires [Node.js](https://nodejs.org/) (LTS) and the [Rust toolchain](https://www.rust-lang.org/tools/install). On Windows you'll also need the [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) with the "Desktop development with C++" workload.

```sh
npm install
npm run tauri dev    # run in development
npm run tauri build  # produce a native installer
```

## License

[MIT](LICENSE)
