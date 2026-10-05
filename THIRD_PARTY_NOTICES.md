# Third-party software

Tachyon TeX embeds the official [Tectonic typesetting engine](https://github.com/tectonic-typesetting/tectonic/releases/tag/tectonic%400.17.0) 0.17.0 executable. The upstream archive checksums and target mapping are pinned in build.rs. Tectonic and its Rust/native dependencies retain their own licenses and copyright notices. The project's LICENSE applies to this project's own code.

Release archives include a `licenses/` directory with notices for Fontconfig, FreeType, HarfBuzz, Graphite2, ICU, libpng, and zlib, the Tectonic license, and license files collected from resolved Rust dependencies. Preserve these notices and the project LICENSE when redistributing. Tectonic's source and dependency license details are available in its tagged source tree; upstream binaries include those dependencies under their respective terms.

Rust wrapper dependency versions are recorded in Cargo.lock. Full TeX support downloads official TinyTeX distributions separately; TeX Live packages and external programs retain their own licenses. TinyTeX/TeX Live include their licensing information in the downloaded distribution. This project does not change those terms.
