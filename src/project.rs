use anyhow::{bail, ensure, Context, Result};
use regex::Regex;
use std::fs::{self, File};
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use tempfile::TempDir;

const MAX_ARCHIVE_BYTES: u64 = 512 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES: usize = 10_000;

pub struct Project {
    pub main: PathBuf,
    pub default_output_dir: PathBuf,
    // The extracted project must survive until the engine finishes.
    _extracted: Option<TempDir>,
}

impl Project {
    pub fn open(input: &Path, main: Option<&Path>) -> Result<Self> {
        let input = fs::canonicalize(input)
            .with_context(|| format!("cannot open input {}", input.display()))?;
        if input.is_dir() {
            return Ok(Self {
                main: find_main(&input, main)?,
                default_output_dir: input,
                _extracted: None,
            });
        }
        let parent = input
            .parent()
            .context("input has no parent directory")?
            .to_owned();
        if extension_is(&input, "tex") {
            ensure!(
                main.is_none(),
                "--main is only supported for directories and ZIP archives"
            );
            return Ok(Self {
                main: input,
                default_output_dir: parent,
                _extracted: None,
            });
        }
        ensure!(
            extension_is(&input, "zip"),
            "input must be a .tex file, directory, or ZIP archive"
        );
        let extracted = tempfile::tempdir().context("cannot create ZIP extraction directory")?;
        extract_archive(&input, extracted.path())?;
        Ok(Self {
            main: find_main(extracted.path(), main)?,
            default_output_dir: parent,
            _extracted: Some(extracted),
        })
    }
}

fn extension_is(path: &Path, extension: &str) -> bool {
    path.extension()
        .is_some_and(|ext| ext.eq_ignore_ascii_case(extension))
}

fn find_main(root: &Path, requested: Option<&Path>) -> Result<PathBuf> {
    let root = fs::canonicalize(root)?;
    if let Some(requested) = requested {
        ensure!(
            !requested.is_absolute(),
            "--main must be relative to the project root"
        );
        let path = fs::canonicalize(root.join(requested))
            .with_context(|| format!("cannot open main file {}", requested.display()))?;
        ensure!(
            path.starts_with(&root),
            "--main must stay inside the project"
        );
        ensure!(
            path.is_file() && extension_is(&path, "tex"),
            "--main must name a .tex file"
        );
        return Ok(path);
    }
    let mut files = Vec::new();
    collect_tex(&root, &mut files, 0)?;
    files.sort();
    let document = Regex::new(r"\\begin\s*\{document\}")?;
    let mut candidates = Vec::new();
    for path in files {
        let content =
            fs::read_to_string(&path).with_context(|| format!("cannot read {}", path.display()))?;
        if document.is_match(&without_comments(&content)) {
            candidates.push(path);
        }
    }
    let preferred = root.join("main.tex");
    if candidates.contains(&preferred) {
        return Ok(preferred);
    }
    match candidates.len() {
        0 => bail!("no main .tex file containing \\begin{{document}} found; specify --main"),
        1 => Ok(candidates.remove(0)),
        _ => bail!(
            "multiple main files found ({}); choose one with --main",
            candidates
                .iter()
                .map(|p| p.strip_prefix(&root).unwrap_or(p).display().to_string())
                .collect::<Vec<_>>()
                .join(", ")
        ),
    }
}

fn without_comments(content: &str) -> String {
    let mut result = String::new();
    for line in content.lines() {
        let mut slashes = 0;
        for ch in line.chars() {
            if ch == '%' && slashes % 2 == 0 {
                break;
            }
            result.push(ch);
            slashes = if ch == '\\' { slashes + 1 } else { 0 };
        }
        result.push('\n');
    }
    result
}

fn collect_tex(root: &Path, files: &mut Vec<PathBuf>, depth: usize) -> Result<()> {
    ensure!(depth <= 64, "project directories are nested too deeply");
    for entry in fs::read_dir(root)? {
        let entry = entry?;
        let kind = entry.file_type()?;
        // Do not traverse links or generated/dependency directories.
        if kind.is_dir() {
            if !matches!(
                entry.file_name().to_str(),
                Some(".git" | "target" | "node_modules" | "dist")
            ) {
                collect_tex(&entry.path(), files, depth + 1)?;
            }
        } else if kind.is_file() && extension_is(&entry.path(), "tex") {
            files.push(entry.path());
        }
    }
    Ok(())
}

fn extract_archive(input: &Path, destination: &Path) -> Result<()> {
    let mut archive = zip::ZipArchive::new(File::open(input)?).context("invalid ZIP archive")?;
    ensure!(
        archive.len() <= MAX_ARCHIVE_ENTRIES,
        "ZIP contains too many entries"
    );
    let mut remaining = MAX_ARCHIVE_BYTES;
    for index in 0..archive.len() {
        let mut entry = archive.by_index(index)?;
        let name = entry.name().replace('\\', "/");
        let relative = Path::new(&name);
        ensure!(
            relative
                .components()
                .all(|part| matches!(part, Component::Normal(_) | Component::CurDir))
                && !name.contains(':')
                && !name.starts_with('/'),
            "unsafe ZIP path: {name}"
        );
        ensure!(
            entry
                .unix_mode()
                .is_none_or(|mode| mode & 0o170000 != 0o120000),
            "ZIP symbolic links are not supported"
        );
        let target = destination.join(relative);
        if entry.is_dir() {
            fs::create_dir_all(&target)?;
            continue;
        }
        ensure!(
            entry.size() <= remaining,
            "ZIP exceeds the 512 MiB extraction limit"
        );
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent)?;
        }
        let mut file = File::options()
            .write(true)
            .create_new(true)
            .open(&target)
            .with_context(|| format!("cannot extract ZIP entry {name}"))?;
        let written = std::io::copy(&mut (&mut entry).take(remaining + 1), &mut file)?;
        ensure!(
            written <= remaining,
            "ZIP exceeds the 512 MiB extraction limit"
        );
        remaining -= written;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn document(path: &Path) {
        fs::write(
            path,
            "\\documentclass{article}\n\\begin{document}Hello\\end{document}",
        )
        .unwrap();
    }

    fn archive(path: &Path, name: &str, mode: Option<u32>) {
        let mut zip = zip::ZipWriter::new(File::create(path).unwrap());
        let mut options = zip::write::FileOptions::default();
        if let Some(mode) = mode {
            options = options.unix_permissions(mode);
        }
        zip.start_file(name, options).unwrap();
        zip.write_all(b"\\begin{document}Hello\\end{document}")
            .unwrap();
        zip.finish().unwrap();
    }

    #[test]
    fn explicit_tex_and_default_output() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("report.TEX");
        document(&path);
        let project = Project::open(&path, None).unwrap();
        assert_eq!(project.main, fs::canonicalize(path).unwrap());
        assert_eq!(
            project.default_output_dir,
            fs::canonicalize(dir.path()).unwrap()
        );
    }

    #[test]
    fn discovers_nested_document_and_skips_comments() {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir(dir.path().join("paper")).unwrap();
        document(&dir.path().join("paper/report.tex"));
        fs::write(
            dir.path().join("chapter.tex"),
            "% \\begin{document}\nOnly a chapter",
        )
        .unwrap();
        let project = Project::open(dir.path(), None).unwrap();
        assert!(project.main.ends_with("paper/report.tex"));
    }

    #[test]
    fn prefers_main_tex() {
        let dir = tempfile::tempdir().unwrap();
        document(&dir.path().join("main.tex"));
        document(&dir.path().join("other.tex"));
        assert!(Project::open(dir.path(), None)
            .unwrap()
            .main
            .ends_with("main.tex"));
    }

    #[test]
    fn ambiguity_requires_main_selection() {
        let dir = tempfile::tempdir().unwrap();
        document(&dir.path().join("one.tex"));
        document(&dir.path().join("two.tex"));
        assert!(Project::open(dir.path(), None)
            .err()
            .unwrap()
            .to_string()
            .contains("multiple main"));
        assert!(Project::open(dir.path(), Some(Path::new("two.tex")))
            .unwrap()
            .main
            .ends_with("two.tex"));
    }

    #[test]
    fn explicit_main_cannot_escape_project() {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir(dir.path().join("project")).unwrap();
        document(&dir.path().join("outside.tex"));
        assert!(Project::open(
            &dir.path().join("project"),
            Some(Path::new("../outside.tex"))
        )
        .is_err());
    }

    #[test]
    fn archive_project_stays_alive() {
        let dir = tempfile::tempdir().unwrap();
        let zip = dir.path().join("paper.zip");
        archive(&zip, "paper/main.tex", None);
        let project = Project::open(&zip, None).unwrap();
        let extracted_main = project.main.clone();
        assert!(extracted_main.is_file());
        assert_eq!(
            project.default_output_dir,
            fs::canonicalize(dir.path()).unwrap()
        );
        drop(project);
        assert!(!extracted_main.exists());
    }

    #[test]
    fn rejects_zip_traversal_on_both_platforms() {
        let dir = tempfile::tempdir().unwrap();
        for name in [
            "../outside.tex",
            "..\\outside.tex",
            "/main.tex",
            "C:/main.tex",
            "C:\\main.tex",
        ] {
            let zip = dir.path().join("bad.zip");
            archive(&zip, name, None);
            assert!(Project::open(&zip, None).is_err(), "accepted {name}");
        }
        assert!(!dir.path().join("outside.tex").exists());
    }

    #[test]
    fn rejects_missing_unsupported_and_invalid_inputs() {
        let dir = tempfile::tempdir().unwrap();
        assert!(Project::open(&dir.path().join("missing.tex"), None).is_err());
        let unsupported = dir.path().join("file.txt");
        fs::write(&unsupported, "hello").unwrap();
        assert!(Project::open(&unsupported, None).is_err());
        let zip = dir.path().join("broken.zip");
        fs::write(&zip, "not a zip").unwrap();
        assert!(Project::open(&zip, None).is_err());
        assert!(Project::open(dir.path(), None).is_err());
    }

    #[test]
    fn rejects_duplicate_zip_entries() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("duplicate.zip");
        let mut zip = zip::ZipWriter::new(File::create(&path).unwrap());
        for _ in 0..2 {
            zip.start_file("main.tex", zip::write::FileOptions::default())
                .unwrap();
            zip.write_all(b"\\begin{document}").unwrap();
        }
        zip.finish().unwrap();
        assert!(Project::open(&path, None).is_err());
    }

    #[test]
    fn rejects_zip_symbolic_links() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("link.zip");
        let mut zip = zip::ZipWriter::new(File::create(&path).unwrap());
        zip.add_symlink(
            "main.tex",
            "../outside.tex",
            zip::write::FileOptions::default(),
        )
        .unwrap();
        zip.finish().unwrap();
        assert!(Project::open(&path, None)
            .err()
            .unwrap()
            .to_string()
            .contains("symbolic links"));
    }

    #[test]
    fn recognizes_escaped_percent_and_real_comments() {
        assert_eq!(
            without_comments("a\\%b% comment\nc\\\\% comment"),
            "a\\%b\nc\\\\\n"
        );
    }
}
