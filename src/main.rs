use anyhow::{Context, Result};
use clap::{Args, Parser, Subcommand};
use std::path::PathBuf;
use std::process::ExitCode;
use std::time::Instant;

mod compiler;
mod engine;
mod project;
mod update;

#[derive(Parser)]
#[command(version, about = "Compile LaTeX to PDF without Docker or a server")]
#[command(arg_required_else_help = true, args_conflicts_with_subcommands = true)]
struct Cli {
    #[command(subcommand)]
    command: Option<Commands>,
    #[command(flatten)]
    compile: CompileArgs,
    /// Skip the startup version check (also: TACHYON_NO_UPDATE_CHECK=1)
    #[arg(long, global = true)]
    no_update_check: bool,
    /// Notify about updates without installing them automatically
    #[arg(long, global = true)]
    no_auto_update: bool,
}

#[derive(Subcommand)]
enum Commands {
    /// Compile a .tex file, project directory, or ZIP archive
    Compile(CompileArgs),
    /// Download, verify, and install the latest release
    Update,
    /// Report platform, cache, embedded engine, and full TeX availability
    Doctor,
}

#[derive(Args)]
struct CompileArgs {
    /// Input .tex file, project directory, or ZIP archive
    input: Option<PathBuf>,
    /// Main .tex file relative to the project directory or archive
    #[arg(long)]
    main: Option<PathBuf>,
    /// Destination PDF path (default: beside the input)
    #[arg(short, long, conflicts_with = "out_dir")]
    output: Option<PathBuf>,
    /// Directory for the PDF and optional intermediate files
    #[arg(long)]
    out_dir: Option<PathBuf>,
    /// Use cached LaTeX packages only; do not access the network
    #[arg(long, alias = "only-cached")]
    offline: bool,
    /// Use a local package bundle (directory or ZIP), or a bundle URL
    #[arg(long)]
    bundle: Option<String>,
    /// Save the engine's .log file
    #[arg(long)]
    keep_logs: bool,
    /// Save .aux, .bbl, and other intermediate files
    #[arg(short = 'k', long)]
    keep_intermediates: bool,
    /// Generate SyncTeX data for editor integration
    #[arg(long)]
    synctex: bool,
    /// Suppress progress messages (errors are still printed)
    #[arg(short, long)]
    quiet: bool,
    /// Select the backend; auto detects documents requiring full TeX
    #[arg(long, value_enum, default_value = "auto")]
    engine: compiler::Backend,
    /// Full TeX engine used by latexmk
    #[arg(long, value_enum)]
    tex_engine: Option<compiler::TexEngine>,
    /// Allow external commands for trusted documents (requires latexmk)
    #[arg(long)]
    shell_escape: bool,
    /// Print a machine-readable result to stdout
    #[arg(long)]
    json: bool,
}

fn main() -> ExitCode {
    let cli = Cli::parse();
    if matches!(cli.command, Some(Commands::Update)) {
        return finish(update::install_latest().map(|_| ()));
    }
    if matches!(cli.command, Some(Commands::Doctor)) {
        println!(
            "{}",
            serde_json::json!({"version": env!("CARGO_PKG_VERSION"), "platform": update::platform(), "cache": engine::cache_root(), "embedded_engine": "Tectonic 0.17.0", "latexmk": std::process::Command::new("latexmk").arg("-version").output().is_ok()})
        );
        return ExitCode::SUCCESS;
    }
    if !cli.no_update_check && std::env::var_os("TACHYON_NO_UPDATE_CHECK").is_none() {
        update::startup(!cli.no_auto_update);
    }
    let args = match cli.command {
        Some(Commands::Compile(args)) => args,
        None => cli.compile,
        _ => unreachable!(),
    };
    let json = args.json;
    match run(args) {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            if json {
                println!(
                    "{}",
                    serde_json::json!({"ok": false, "error": format!("{error:#}")})
                );
            }
            eprintln!("error: {error:#}");
            ExitCode::FAILURE
        }
    }
}

fn finish(result: Result<()>) -> ExitCode {
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("error: {error:#}");
            ExitCode::FAILURE
        }
    }
}

fn run(args: CompileArgs) -> Result<()> {
    let input = args
        .input
        .context("an input is required; use --help for usage")?;
    let project = project::Project::open(&input, args.main.as_deref())?;
    let output = match args.output {
        Some(path) => path,
        None => args
            .out_dir
            .unwrap_or_else(|| project.default_output_dir.clone())
            .join(project.main.file_name().context("invalid main filename")?)
            .with_extension("pdf"),
    };
    anyhow::ensure!(
        output
            .extension()
            .is_some_and(|ext| ext.eq_ignore_ascii_case("pdf")),
        "output must have a .pdf extension"
    );
    let started = Instant::now();
    if !args.quiet {
        eprintln!("Compiling {}", project.main.display());
    }
    let report = compiler::compile(
        &project.main,
        &output,
        &compiler::Options {
            offline: args.offline,
            bundle: args.bundle,
            keep_logs: args.keep_logs,
            keep_intermediates: args.keep_intermediates,
            synctex: args.synctex,
            quiet: args.quiet,
            engine: if matches!(args.engine, compiler::Backend::Auto) && args.tex_engine.is_some() {
                compiler::Backend::Latexmk
            } else {
                args.engine
            },
            tex_engine: args
                .tex_engine
                .unwrap_or_else(|| compiler::infer_tex_engine(&project.main)),
            shell_escape: args.shell_escape,
        },
    )?;
    if args.json {
        println!(
            "{}",
            serde_json::json!({"ok": true, "output": std::fs::canonicalize(&output)?, "engine": report.engine, "warnings": report.warnings, "duration_ms": started.elapsed().as_millis()})
        );
    }
    if !args.quiet {
        eprintln!(
            "PDF: {} ({:.2}s)",
            output.display(),
            started.elapsed().as_secs_f64()
        );
    }
    Ok(())
}
