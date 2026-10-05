# Tachyon TeX CLI

Compile LaTeX to PDF from the terminal or give an AI agent a self-contained skill that installs the correct binary and runs live browser previews. Supports Windows, Linux, and macOS on x64 and ARM64. No Docker is required.

## Quick start

With [Node.js 22+](https://nodejs.org/en/download):

```sh
npx --yes github:srsergi0/tachyon-tex-cli --help
npx --yes github:srsergi0/tachyon-tex-cli main.tex
npx --yes github:srsergi0/tachyon-tex-cli ./project --main main.tex --output ./build/paper.pdf --json
```

The launcher detects OS/CPU, downloads the matching release executable, verifies SHA-256, and caches it in your user directory. Administrator permissions are not required. The first compilation downloads LaTeX packages; subsequent builds reuse the cache. `--offline` requires the binary and needed packages to be cached.

This distribution uses GitHub directly; there is no npm registry package. Pin the launcher with `github:srsergi0/tachyon-tex-cli#v2.0.0`; also use `--no-auto-update` or an offline cache when a fixed binary is required.

## Agent skill

Install with the [Agent Skills CLI](https://github.com/vercel-labs/skills):

```sh
npx skills add srsergi0/tachyon-tex-cli --skill tachyon-tex
```

Select your agent/scope when prompted. The skill follows the [Agent Skills specification](https://agentskills.io/specification), includes engine-selection and diagnostic guidance, and contains self-contained scripts. An installed skill can run `node /path/to/tachyon-tex/scripts/cli.mjs main.tex --json` without a repository checkout or npm dependencies. Its script automatically selects and installs the correct OS binary. See [SKILL.md](skills/tachyon-tex/SKILL.md).

## Live preview

```sh
npx --yes github:srsergi0/tachyon-tex-cli background ./project --main main.tex --open
npx --yes github:srsergi0/tachyon-tex-cli status --json
npx --yes github:srsergi0/tachyon-tex-cli logs ./project
npx --yes github:srsergi0/tachyon-tex-cli logs ./project --follow
npx --yes github:srsergi0/tachyon-tex-cli stop ./project
```

`watch main.tex --open` runs in the foreground. `background` and `watch --background` detach the process so it survives the terminal. Changes trigger serial recompilation; edits during a build are picked up afterward. Local packages, bibliographies, graphics, and data files are watched recursively. Generated auxiliaries, the preview PDF, `.git`, `node_modules`, `target`, and `dist` are excluded. Symlinks and dependencies outside the root are not watched.

The HTTP preview binds to `127.0.0.1`, selects a free port, and refreshes the PDF after a successful build. Errors appear in the browser/log and retain the previous PDF. Use `--port 8080` or `--interval 1000` to configure it. Watch accepts files/directories; extract ZIP projects first.

Canonical input path plus main-file choice identifies a session. Repeating a background request returns the existing session. With multiple sessions, give logs/stop an input path; `stop --all` stops all. Status/logs require no network; stopped sessions retain their log. Foreground diagnostics print in the terminal and are also saved.

## Engines and compatibility

| Requirement | Backend |
| --- | --- |
| Ordinary LaTeX, math, TikZ, XeTeX, Unicode, BibTeX, graphics | Embedded Tectonic 0.17.0 |
| pdfLaTeX | `--engine latexmk --tex-engine pdflatex` |
| LuaLaTeX | `--engine latexmk --tex-engine lualatex` |
| biblatex / Biber | `--engine latexmk` |
| External commands / minted | `--engine latexmk --shell-escape` for trusted documents, plus the required tool |

`--engine auto` detects requirements in the main source, including biblatex, minted, direct Lua code, and common `% !TeX program = ...` directives. Select a backend explicitly for requirements in included files. `--tex-engine` selects full TeX. External commands are disabled by default.

```sh
npx --yes github:srsergi0/tachyon-tex-cli setup --full
npx --yes github:srsergi0/tachyon-tex-cli main.tex --engine latexmk --tex-engine lualatex
npx --yes github:srsergi0/tachyon-tex-cli setup --full --all-packages
```

The launcher installs an official [TinyTeX](https://github.com/rstudio/tinytex-releases) archive with its published SHA-256 digest in the user cache and uses `tlmgr` for latexmk, Biber, LuaTeX, and font packages. For missing TeX package files in this managed backend, online compilation searches the official package repository and installs matching packages with at most three retries. It changes only the child environment, leaving system PATH untouched. `--all-packages` installs the full TeX Live scheme and requires substantial space/time. Existing TeX Live/MiKTeX with latexmk on PATH is also supported. Portable TinyTeX discovery is supplied by the Node launcher; musl ARM64 full TeX requires a system installation because upstream TinyTeX does not provide that archive.

No compiler can guarantee every arbitrary project: project-specific fonts, missing assets, proprietary classes, external tools (Inkscape, Python/Pygments, etc.), custom build scripts, and invalid source must be supplied or corrected. Full TeX provides broader compatibility than Tectonic's versioned bundle. Errors retain the backend's original diagnostic. Source is never silently rewritten. Offline mode disables launcher/Tectonic downloads; configure external MiKTeX to disable its own automatic downloads if required.

## Native releases

Download your archive from [Releases](https://github.com/srsergi0/tachyon-tex-cli/releases/latest), extract it, and run `tachyon-tex[.exe] --help`. Native binaries need no Node.js. They offer `compile`, `doctor`, and `update`; the Node launcher/skill supplies watch and portable full-TeX installation.

| Platform asset | Requirements |
| --- | --- |
| windows-x64 | Windows 10/11 x64; static CRT |
| windows-arm64 | Windows 11 ARM64; upstream embedded x64 Tectonic uses Windows x64 emulation |
| linux-x64 | Static musl x64 wrapper and engine |
| linux-arm64 | Static musl ARM64 wrapper and engine |
| macos-x64 | Native Intel macOS |
| macos-arm64 | Native Apple Silicon macOS |

Linux system fonts need installed fonts and Fontconfig configuration; bundled LaTeX fonts download with packages. Verify assets against `SHA256SUMS`. Archives include licenses and the skill; raw assets support the installer. Releases publish GitHub build provenance attestations.

## Updates and machine-readable output

Normal compilation checks for newer releases at most once per hour and automatically installs a verified new binary. The cached binary remains usable when release checks cannot reach GitHub. Native executables also check at startup and can replace themselves. Help/version never access the network. Background sessions keep their binary until restarted.

```sh
npx --yes github:srsergi0/tachyon-tex-cli update
npx --yes github:srsergi0/tachyon-tex-cli main.tex --no-auto-update
npx --yes github:srsergi0/tachyon-tex-cli main.tex --no-update-check
npx --yes github:srsergi0/tachyon-tex-cli main.tex --offline --json
```

`--json` emits `{ "ok": true, "output": "...", "engine": "tectonic", "warnings": [], "duration_ms": 123 }` on stdout. Failure emits `{ "ok": false, "error": "..." }` and exits 1. Diagnostics/update notices use stderr; native argument errors exit 2. Session status is a JSON array containing state, revision, URL, output, and last error. Control tokens remain private.

| Environment variable | Purpose |
| --- | --- |
| `TACHYON_CACHE_DIR` | Override installation/engine/session cache |
| `TACHYON_NO_UPDATE_CHECK=1` | Disable startup checks |
| `TACHYON_BINARY` | Explicit local binary override for development/managed use |
| `FONTCONFIG_FILE`, `FONTCONFIG_PATH` | Custom font configuration |

`doctor` reports platform, cache, engine version, and latexmk availability. Cache defaults: `%LOCALAPPDATA%/TachyonTex` (Windows), `~/Library/Caches/tachyon-tex` (macOS), `$XDG_CACHE_HOME/tachyon-tex` or `~/.cache/tachyon-tex` (Linux). Tectonic has a separate package cache.

## Build and test

Rust stable, Node.js 22+, and HTTPS access are required. `build.rs` downloads and verifies a pinned official Tectonic executable before embedding it. No vcpkg or installed TeX is needed to build the wrapper.

```sh
cargo fmt --check
cargo clippy --locked --all-targets -- -D warnings
cargo test --locked
cargo build --locked
npm run check
npm test
cargo build --locked --release
```

Linux static builds require `musl-tools` for C dependencies and the Rust musl target. The Cargo configuration uses Rust's bundled linker/CRT to avoid mixing system musl versions. CI uses native runners for all six OS/CPU combinations, runs real PDF/background lifecycle tests, and publishes only when every platform passes. Set `TACHYON_BINARY` for target-specific Node tests. `TACHYON_EMBED_ENGINE_PATH` is a development override; official builds use the pinned upstream archive.

The original [Fair Source 0.9 license](LICENSE), including its usage conditions, is preserved. Third-party components retain their licenses; see [notices](THIRD_PARTY_NOTICES.md).
