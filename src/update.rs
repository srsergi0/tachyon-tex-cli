use anyhow::{bail, Context, Result};
use semver::Version;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::Write,
    process::Command,
    time::{Duration, SystemTime},
};

const API: &str = "https://api.github.com/repos/srsergi0/tachyon-tex-cli/releases/latest";
#[derive(Deserialize, Serialize)]
struct Release {
    tag_name: String,
}

pub fn platform() -> String {
    let os = match std::env::consts::OS {
        "windows" => "windows",
        "macos" => "macos",
        _ => "linux",
    };
    let arch = match std::env::consts::ARCH {
        "aarch64" => "arm64",
        _ => "x64",
    };
    format!("{os}-{arch}")
}

fn client(timeout: u64) -> Result<reqwest::blocking::Client> {
    Ok(reqwest::blocking::Client::builder()
        .user_agent("tachyon-tex/2")
        .timeout(Duration::from_secs(timeout))
        .build()?)
}

fn newer(tag: &str) -> Result<bool> {
    Ok(Version::parse(tag.trim_start_matches('v'))? > Version::parse(env!("CARGO_PKG_VERSION"))?)
}

pub fn startup(automatic: bool) {
    if std::env::var_os("TACHYON_UPDATED").is_some() {
        return;
    }
    let check = || -> Result<()> {
        let cache = crate::engine::cache_root().join("version-check.json");
        let fresh = fs::metadata(&cache)
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| SystemTime::now().duration_since(t).ok())
            .is_some_and(|age| age < Duration::from_secs(3600));
        let release: Release = if fresh {
            serde_json::from_slice(&fs::read(&cache)?)?
        } else {
            let release = client(2)?
                .get(API)
                .send()?
                .error_for_status()?
                .json::<Release>()?;
            fs::create_dir_all(cache.parent().unwrap())?;
            fs::write(&cache, serde_json::to_vec(&release)?)?;
            release
        };
        if newer(&release.tag_name)? {
            eprintln!(
                "New version available: {} (current: {}).",
                release.tag_name,
                env!("CARGO_PKG_VERSION")
            );
            if automatic {
                let executable = std::env::current_exe()?;
                match install(&release.tag_name) {
                    Ok(()) => {
                        let status = Command::new(executable).args(std::env::args_os().skip(1)).env("TACHYON_UPDATED", "1").status()?;
                        std::process::exit(status.code().unwrap_or(1));
                    }
                    Err(error) => eprintln!("Automatic update failed: {error:#}. Continuing with the installed version. Run tachyon-tex update to retry."),
                }
            } else {
                eprintln!("Run tachyon-tex update to install it.");
            }
        }
        Ok(())
    };
    // Network failures must never block normal compilation.
    let _ = check();
}

pub fn install_latest() -> Result<bool> {
    let release: Release = client(15)?.get(API).send()?.error_for_status()?.json()?;
    if !newer(&release.tag_name)? {
        eprintln!("Already up to date ({}).", env!("CARGO_PKG_VERSION"));
        return Ok(false);
    }
    install(&release.tag_name)?;
    Ok(true)
}

fn install(tag: &str) -> Result<()> {
    // Parse before using a server-provided tag in a filesystem path or URL.
    Version::parse(tag.trim_start_matches('v'))?;
    let suffix = if cfg!(windows) { ".exe" } else { "" };
    let name = format!("tachyon-tex-{tag}-{}{suffix}", platform());
    let base = format!("https://github.com/srsergi0/tachyon-tex-cli/releases/download/{tag}");
    let http = client(300)?;
    let sums = http
        .get(format!("{base}/SHA256SUMS"))
        .send()?
        .error_for_status()?
        .text()?;
    let expected = sums
        .lines()
        .find_map(|line| {
            let mut parts = line.split_whitespace();
            let hash = parts.next()?;
            (parts.next()?.trim_start_matches('*') == name).then_some(hash)
        })
        .context("release checksum is missing for this platform")?;
    let bytes = http
        .get(format!("{base}/{name}"))
        .send()?
        .error_for_status()?
        .bytes()?;
    let actual = format!("{:x}", Sha256::digest(&bytes));
    if actual != expected {
        bail!("download checksum mismatch; the installed executable was not changed");
    }
    let mut temp = tempfile::NamedTempFile::new()?;
    temp.write_all(&bytes)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(temp.path(), fs::Permissions::from_mode(0o755))?;
    }
    self_replace::self_replace(temp.path())
        .context("cannot replace executable; check installation directory permissions")?;
    eprintln!(
        "Updated to {tag} (verified SHA-256, {} bytes).",
        bytes.len()
    );
    Ok(())
}
