Portable LaTeX compiler and self-contained Agent Skill for Windows, Linux, and macOS (x64 and ARM64).

- Native executable with embedded Tectonic 0.17.0; no Docker or preinstalled TeX required for the default backend.
- GitHub `npx` launcher selects the correct platform asset, verifies SHA-256, caches it, and automatically checks for updates.
- Full TeX backend supports pdfLaTeX, XeLaTeX, LuaLaTeX, Biber, and trusted shell escape through latexmk. `setup --full` installs portable TinyTeX.
- `watch`, `background`, `status`, `logs`, and `stop` provide a local browser preview with automatic recompilation and persistent diagnostics.
- English CLI help, documentation, JSON results, and agent instructions. Compilation failures preserve the previous PDF.

Install the skill: `npx skills add srsergi0/tachyon-tex-cli --skill tachyon-tex`

Compile: `npx --yes github:srsergi0/tachyon-tex-cli main.tex --json`

Preview: `npx --yes github:srsergi0/tachyon-tex-cli background main.tex --open`

Download the archive for your platform to retain licenses and the skill. Raw executable assets are used by the verified installer. Windows ARM64 embeds the upstream x64 Tectonic engine and requires Windows 11 x64 emulation. Third-party programs and fonts required by individual documents remain separate dependencies. See the README compatibility guide.
