use anyhow::{bail, Context, Result};
use sha2::{Digest, Sha256};
use std::{
    env, fs,
    io::{Cursor, Read},
    path::PathBuf,
    time::Duration,
};

fn main() {
    println!("cargo:rerun-if-changed=build.rs");
    println!("cargo:rerun-if-env-changed=TACHYON_EMBED_ENGINE_PATH");
    if let Err(error) = prepare() {
        panic!("Cannot embed the Tectonic engine: {error:#}");
    }
}

fn prepare() -> Result<()> {
    let target = env::var("TARGET")?;
    let (artifact, expected) = match target.as_str() {
        "x86_64-pc-windows-msvc" | "aarch64-pc-windows-msvc" =>
            ("x86_64-pc-windows-msvc.zip", "f61ce51f0b0ade1015b7de7ef368541c5424e9756ecbd0d7af97d6d48030845f"),
        "x86_64-unknown-linux-musl" | "x86_64-unknown-linux-gnu" =>
            ("x86_64-unknown-linux-musl.tar.gz", "8533d07f9ccbd7a65824b9e0459041bca34af1eb33daba48f59215593753a3b7"),
        "aarch64-unknown-linux-musl" | "aarch64-unknown-linux-gnu" =>
            ("aarch64-unknown-linux-musl.tar.gz", "b10954a95404f3ab2328d2fa59a5ebab8e657f893fab096f98be8db7c0c979b8"),
        "x86_64-apple-darwin" =>
            ("x86_64-apple-darwin.tar.gz", "7c90ef5b6ddb1eb1937e4337add5237b79338e4b9676459fa91187d24d6cdf80"),
        "aarch64-apple-darwin" =>
            ("aarch64-apple-darwin.tar.gz", "a3f1cac7c5678f01661a92212f58480ae3b0634115d880dbc59e2953ded45667"),
        _ => bail!("Unsupported target {target}. Supported: Windows x64/arm64, Linux x64/arm64, macOS x64/arm64."),
    };
    let root = PathBuf::from(env::var("CARGO_MANIFEST_DIR")?);
    let cache = root.join("target/embedded-engine");
    fs::create_dir_all(&cache)?;
    let engine_name = if target.contains("windows") {
        "tectonic.exe"
    } else {
        "tectonic"
    };
    let engine_path = match env::var_os("TACHYON_EMBED_ENGINE_PATH") {
        Some(path) => fs::canonicalize(path)?,
        None => {
            let path = cache.join(format!("{expected}-{engine_name}"));
            if !path.is_file() {
                let url = format!("https://github.com/tectonic-typesetting/tectonic/releases/download/tectonic%400.17.0/tectonic-0.17.0-{artifact}");
                let bytes = reqwest::blocking::Client::builder()
                    .timeout(Duration::from_secs(300))
                    .build()?
                    .get(&url)
                    .send()?
                    .error_for_status()?
                    .bytes()?;
                anyhow::ensure!(
                    format!("{:x}", Sha256::digest(&bytes)) == expected,
                    "Engine archive SHA-256 mismatch"
                );
                let mut executable = Vec::new();
                if artifact.ends_with(".zip") {
                    let mut archive = zip::ZipArchive::new(Cursor::new(bytes))?;
                    for index in 0..archive.len() {
                        let mut entry = archive.by_index(index)?;
                        if std::path::Path::new(entry.name())
                            .file_name()
                            .is_some_and(|n| n == engine_name)
                        {
                            entry.read_to_end(&mut executable)?;
                            break;
                        }
                    }
                } else {
                    let mut archive =
                        tar::Archive::new(flate2::read::GzDecoder::new(Cursor::new(bytes)));
                    for entry in archive.entries()? {
                        let mut entry = entry?;
                        if entry.header().entry_type().is_file()
                            && entry.path()?.file_name().is_some_and(|n| n == engine_name)
                        {
                            entry.read_to_end(&mut executable)?;
                            break;
                        }
                    }
                }
                anyhow::ensure!(
                    !executable.is_empty(),
                    "Engine executable is missing from the verified archive"
                );
                let temporary = path.with_extension("download");
                fs::write(&temporary, executable)?;
                fs::rename(temporary, &path)?;
            }
            fs::canonicalize(path)?
        }
    };
    let digest = format!(
        "{:x}",
        Sha256::digest(fs::read(&engine_path).context("Cannot read engine executable")?)
    );
    println!(
        "cargo:rustc-env=TACHYON_ENGINE_FILE={}",
        engine_path.display()
    );
    println!("cargo:rustc-env=TACHYON_ENGINE_SHA256={digest}");
    Ok(())
}
