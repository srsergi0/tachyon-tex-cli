use anyhow::{Context, Result};
use sha2::{Digest, Sha256};
use std::{fs, io::Write, path::PathBuf};

pub const ENGINE: &[u8] = include_bytes!(env!("TACHYON_ENGINE_FILE"));

pub fn cache_root() -> PathBuf {
    if let Some(path) = std::env::var_os("TACHYON_CACHE_DIR") {
        return path.into();
    }
    #[cfg(windows)]
    if let Some(path) = std::env::var_os("LOCALAPPDATA") {
        return PathBuf::from(path).join("TachyonTex");
    }
    #[cfg(target_os = "macos")]
    if let Some(path) = std::env::var_os("HOME") {
        return PathBuf::from(path).join("Library/Caches/tachyon-tex");
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    if let Some(path) = std::env::var_os("XDG_CACHE_HOME") {
        return PathBuf::from(path).join("tachyon-tex");
    }
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir)
        .join(".cache/tachyon-tex")
}

pub fn executable() -> Result<PathBuf> {
    let directory = cache_root()
        .join("engines")
        .join(env!("TACHYON_ENGINE_SHA256"));
    fs::create_dir_all(&directory).context("Cannot create the embedded engine cache")?;
    let path = directory.join(if cfg!(windows) {
        "tectonic.exe"
    } else {
        "tectonic"
    });
    if path.is_file() {
        let hash = format!("{:x}", Sha256::digest(fs::read(&path)?));
        if hash == env!("TACHYON_ENGINE_SHA256") {
            return Ok(path);
        }
    }
    let mut file = tempfile::NamedTempFile::new_in(&directory)?;
    file.write_all(ENGINE)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        file.as_file()
            .set_permissions(fs::Permissions::from_mode(0o755))?;
    }
    match file.persist(&path) {
        Ok(_) => (),
        // Another concurrent process may have installed the same verified engine.
        Err(error) if path.is_file() => {
            anyhow::ensure!(
                format!("{:x}", Sha256::digest(fs::read(&path)?)) == env!("TACHYON_ENGINE_SHA256"),
                "Cannot install embedded engine: {}",
                error.error
            );
        }
        Err(error) => return Err(error.error.into()),
    }
    Ok(path)
}
