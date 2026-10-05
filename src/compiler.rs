use anyhow::{bail, Context, Result};
use clap::ValueEnum;
use serde::Serialize;
use std::{fs, io::Write, path::Path, process::Command};

fn external_path(path: &Path) -> std::path::PathBuf {
    #[cfg(windows)]
    {
        let text = path.to_string_lossy();
        if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
            return std::path::PathBuf::from(format!(r"\\{rest}"));
        }
        if let Some(rest) = text.strip_prefix(r"\\?\") {
            return std::path::PathBuf::from(rest);
        }
    }
    path.to_owned()
}

#[derive(Clone, Copy, Debug, ValueEnum)]
pub enum Backend {
    Auto,
    Tectonic,
    Latexmk,
}
#[derive(Clone, Copy, Debug, PartialEq, ValueEnum)]
pub enum TexEngine {
    Xelatex,
    Pdflatex,
    Lualatex,
}
pub struct Options {
    pub offline: bool,
    pub bundle: Option<String>,
    pub keep_logs: bool,
    pub keep_intermediates: bool,
    pub synctex: bool,
    pub quiet: bool,
    pub engine: Backend,
    pub tex_engine: TexEngine,
    pub shell_escape: bool,
}
#[derive(Serialize)]
pub struct Report {
    pub engine: String,
    pub warnings: Vec<String>,
}

fn needs_full_tex(main: &Path) -> bool {
    let text = fs::read_to_string(main).unwrap_or_default();
    text.contains("\\directlua")
        || text.contains("\\usepackage{luacode}")
        || regex::Regex::new(r"\\usepackage(?:\[[^\]]*\])?\{[^}]*\b(?:biblatex|minted)\b")
            .unwrap()
            .is_match(&text)
        || text.lines().take(5).any(|line| {
            line.to_lowercase().contains("tex program = pdflatex")
                || line.to_lowercase().contains("tex program = lualatex")
        })
}

pub fn infer_tex_engine(main: &Path) -> TexEngine {
    let text = fs::read_to_string(main).unwrap_or_default();
    let header = text.lines().take(5).collect::<Vec<_>>().join("\n");
    let magic = regex::Regex::new(r"(?im)%\s*!\s*tex\s+program\s*=\s*(lualatex|pdflatex)").unwrap();
    if let Some(found) = magic.captures(&header) {
        return if found[1].eq_ignore_ascii_case("lualatex") {
            TexEngine::Lualatex
        } else {
            TexEngine::Pdflatex
        };
    }
    if text.contains("\\directlua")
        || text.contains("\\usepackage{luacode}")
        || text
            .lines()
            .take(5)
            .any(|l| l.to_lowercase().contains("tex program = lualatex"))
    {
        TexEngine::Lualatex
    } else if text
        .lines()
        .take(5)
        .any(|l| l.to_lowercase().contains("tex program = pdflatex"))
    {
        TexEngine::Pdflatex
    } else {
        TexEngine::Xelatex
    }
}

pub fn compile(main: &Path, output: &Path, options: &Options) -> Result<Report> {
    let output_dir = output
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    fs::create_dir_all(output_dir)
        .with_context(|| format!("Cannot create output directory {}", output_dir.display()))?;
    let staging = tempfile::tempdir_in(output_dir).context("Cannot create build directory")?;
    // TeX Live/latexmk do not understand Windows verbatim-path prefixes.
    let staging_path = external_path(&fs::canonicalize(staging.path())?);
    let full = matches!(options.engine, Backend::Latexmk)
        || (matches!(options.engine, Backend::Auto)
            && (needs_full_tex(main)
                || options.shell_escape
                || options.tex_engine != TexEngine::Xelatex));
    let filename = main.file_name().context("Invalid main filename")?;
    let mut command;
    let engine;
    #[cfg(windows)]
    let font_config;
    if full {
        engine = "latexmk";
        command = Command::new("latexmk");
        let selected = match options.tex_engine {
            TexEngine::Xelatex => "-xelatex",
            TexEngine::Pdflatex => "-pdf",
            TexEngine::Lualatex => "-lualatex",
        };
        command
            .args([
                selected,
                "-norc",
                "-interaction=nonstopmode",
                "-halt-on-error",
                "-file-line-error",
            ])
            .arg(format!("-outdir={}", staging_path.display()));
        if options.synctex {
            command.arg("-synctex=1");
        }
        if options.shell_escape {
            command.arg("-shell-escape");
        } else {
            command.arg("-no-shell-escape");
        }
    } else {
        engine = "tectonic";
        command = Command::new(crate::engine::executable()?);
        command
            .args(["--color", "never"])
            .arg("--outdir")
            .arg(&staging_path);
        if options.offline {
            command.arg("--only-cached");
        }
        if let Some(bundle) = &options.bundle {
            command.arg("--bundle").arg(bundle);
        }
        if options.keep_logs {
            command.arg("--keep-logs");
        }
        if options.keep_intermediates {
            command.arg("--keep-intermediates");
        }
        if options.synctex {
            command.arg("--synctex");
        }
        if options.quiet {
            command.args(["--chatter", "minimal"]);
        }
        if !options.shell_escape {
            command.arg("--untrusted");
        }
        if options.shell_escape {
            bail!("Tectonic does not provide unrestricted shell escape. Use --engine latexmk --shell-escape for trusted documents.");
        }
        #[cfg(windows)]
        {
            font_config = tempfile::tempdir()?;
            let config_file = font_config.path().join("fonts.conf");
            fs::write(&config_file, include_str!("../assets/fonts.conf"))?;
            if std::env::var_os("FONTCONFIG_FILE").is_none()
                && std::env::var_os("FONTCONFIG_PATH").is_none()
            {
                command.env("FONTCONFIG_FILE", config_file);
            }
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    command
        .current_dir(main.parent().context("Main file has no parent directory")?)
        .arg(filename);
    let result = command.output().with_context(|| if full {
        "latexmk was not found or could not start. Install the full TeX backend with: npx --yes github:srsergi0/tachyon-tex-cli setup --full. LuaLaTeX, pdfLaTeX, Biber, and external tools require a full TeX installation.".to_string()
    } else { "The embedded Tectonic engine could not start. Its cache may be unwritable or the operating system may not support this architecture.".to_string() })?;
    let stdout = String::from_utf8_lossy(&result.stdout);
    let stderr = String::from_utf8_lossy(&result.stderr);
    if !options.quiet || !result.status.success() {
        if !stdout.is_empty() {
            eprint!("{stdout}");
        }
        if !stderr.is_empty() {
            eprint!("{stderr}");
        }
    }
    for entry in fs::read_dir(staging.path())? {
        let entry = entry?;
        let path = entry.path();
        let extension = path.extension().and_then(|ext| ext.to_str()).unwrap_or("");
        let retain = (options.keep_logs && extension == "log")
            || (options.keep_intermediates && extension != "pdf")
            || (options.synctex && entry.file_name().to_string_lossy().ends_with(".synctex.gz"));
        if retain && entry.file_type()?.is_file() {
            fs::copy(&path, output_dir.join(entry.file_name()))?;
        }
    }
    anyhow::ensure!(
        result.status.success(),
        "LaTeX compilation failed using {engine} (exit {}). {}\n{}{}",
        result
            .status
            .code()
            .map(|v| v.to_string())
            .unwrap_or_else(|| "terminated".into()),
        if options.offline {
            "Offline mode is enabled: missing cached packages cannot be downloaded."
        } else {
            "See the file and line in the engine diagnostic below."
        },
        stdout,
        stderr
    );
    let generated = staging.path().join(filename).with_extension("pdf");
    let pdf = fs::read(&generated).context("The engine completed without producing a PDF")?;
    anyhow::ensure!(
        pdf.starts_with(b"%PDF-"),
        "The engine output is not a valid PDF"
    );
    let mut destination = tempfile::NamedTempFile::new_in(output_dir)?;
    destination.write_all(&pdf)?;
    destination
        .persist(output)
        .with_context(|| format!("Cannot write PDF {}", output.display()))?;
    let warnings = stdout
        .lines()
        .chain(stderr.lines())
        .filter(|line| line.to_lowercase().contains("warning"))
        .map(str::to_owned)
        .collect();
    Ok(Report {
        engine: engine.into(),
        warnings,
    })
}
