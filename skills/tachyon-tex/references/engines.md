# Engine and failure guidance

`setup --full` installs portable TinyTeX, latexmk, Biber, LuaTeX, and font packages. `setup --full --all-packages` installs the complete TeX Live scheme with substantial time/disk requirements. Existing full TeX on PATH is also supported. Portable discovery is handled by the launcher.

For LuaLaTeX use `--engine latexmk --tex-engine lualatex`; for pdfLaTeX use `--engine latexmk --tex-engine pdflatex`. Auto detection reads the main file and may miss requirements in included files. Ordinary BibTeX works in Tectonic; biblatex/Biber uses full TeX.

External programs require `--shell-escape` and trusted input. Confirm trust if the existing user authorization does not establish it. Inkscape, gnuplot, Python/Pygments/latexminted, project-specific fonts, and custom build steps remain separate dependencies. Never promise every arbitrary project will compile.

| Diagnostic | Next action |
| --- | --- |
| Undefined command/environment | Inspect source and required packages; fix an actual issue within editing scope |
| Missing source, bibliography, graphics, class | Resolve the expected path and supply the project asset |
| Missing TeX package | Use full TeX or install the required package through its manager |
| Font not found | Install/use the requested font or seek an approved substitute |
| Biber/LuaTeX requirement | Select latexmk and the appropriate engine |
| Cache unavailable offline | Build once online or supply a Tectonic `--bundle` |
| External tool failure | Inspect that tool's diagnostic; avoid unchanged retries |
| SHA-256 mismatch | Fail installation; never bypass verification |

`doctor` reports engine availability. `--keep-logs` and `--keep-intermediates` preserve useful artifacts. Errors include the compiler's original file/line diagnostic. A failed build retains the previous PDF.
