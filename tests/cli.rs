use std::fs;
use std::io::Write;
use std::path::Path;
use std::process::{Command, Output};

const DOCUMENT: &str = "\\documentclass{article}\n\\begin{document}Hello Tachyon\\end{document}\n";

fn cli(root: &Path, args: &[&str]) -> Output {
    // Resolve through Cargo, never rely on an installed executable or Docker.
    Command::new(env!("CARGO_BIN_EXE_tachyon-tex"))
        .current_dir(root)
        .env("TACHYON_NO_UPDATE_CHECK", "1")
        .args(args)
        .output()
        .expect("failed to launch CLI")
}

fn success(output: Output) {
    assert!(
        output.status.success(),
        "exit: {:?}\nstdout: {}\nstderr: {}",
        output.status.code(),
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}

fn pdf(path: &Path) {
    let bytes = fs::read(path).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
    assert!(bytes.starts_with(b"%PDF-"));
    assert!(bytes.len() > 1000);
}

#[test]
fn help_and_version_do_not_start_a_server() {
    let dir = tempfile::tempdir().unwrap();
    let help = cli(dir.path(), &["--help"]);
    assert!(help.status.success());
    let text = String::from_utf8_lossy(&help.stdout);
    assert!(text.contains("--offline") && text.contains("--output"));
    assert!(!text.contains("  serve"));
    success(cli(dir.path(), &["--version"]));
    let empty = cli(dir.path(), &[]);
    assert!(!empty.status.success());
    assert!(String::from_utf8_lossy(&empty.stderr).contains("Usage"));
}

#[test]
fn invalid_arguments_and_inputs_fail() {
    let dir = tempfile::tempdir().unwrap();
    fs::write(dir.path().join("main.tex"), DOCUMENT).unwrap();
    for args in [
        vec!["compile"],
        vec!["missing.tex"],
        vec!["main.tex", "--main", "main.tex"],
        vec!["main.tex", "-o", "main.tex"],
        vec!["main.tex", "-o", "a.pdf", "--out-dir", "out"],
        vec!["main.tex", "--unknown"],
        vec!["main.tex", "--bundle", "missing-bundle.zip"],
    ] {
        assert!(
            !cli(dir.path(), &args).status.success(),
            "accepted {args:?}"
        );
    }
    assert_eq!(
        fs::read_to_string(dir.path().join("main.tex")).unwrap(),
        DOCUMENT
    );
}

#[test]
fn real_compilation_files_directories_zip_and_errors() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    let project = root.join("proyecto con espacios á");
    fs::create_dir_all(project.join("sections")).unwrap();
    fs::write(
        project.join("main.tex"),
        "\\documentclass{article}\n\\begin{document}\\input{sections/body}\\end{document}\n",
    )
    .unwrap();
    fs::write(
        project.join("sections/body.tex"),
        "A local included chapter.",
    )
    .unwrap();
    // The first build may populate the user's Tectonic package cache.
    success(cli(
        root,
        &[
            "compile",
            "proyecto con espacios á/main.tex",
            "-o",
            "output/report.pdf",
            "--keep-logs",
            "--keep-intermediates",
            "--synctex",
        ],
    ));
    pdf(&root.join("output/report.pdf"));
    assert!(root.join("output/main.log").is_file());
    assert!(root.join("output/main.aux").is_file());
    assert!(root.join("output/main.synctex.gz").is_file());
    // Repeat in offline mode and exercise replacement of an existing output.
    success(cli(
        root,
        &[
            "proyecto con espacios á/main.tex",
            "-o",
            "output/report.pdf",
            "--offline",
            "--quiet",
        ],
    ));
    pdf(&root.join("output/report.pdf"));
    success(cli(root, &["proyecto con espacios á", "--offline"]));
    pdf(&project.join("main.pdf"));
    success(cli(
        root,
        &[
            "proyecto con espacios á",
            "--main",
            "main.tex",
            "--out-dir",
            "custom",
            "--offline",
        ],
    ));
    pdf(&root.join("custom/main.pdf"));

    let zip_path = root.join("project.zip");
    let mut zip = zip::ZipWriter::new(fs::File::create(&zip_path).unwrap());
    for (name, content) in [
        (
            "paper/main.tex",
            fs::read(project.join("main.tex")).unwrap(),
        ),
        (
            "paper/sections/body.tex",
            fs::read(project.join("sections/body.tex")).unwrap(),
        ),
    ] {
        zip.start_file(name, zip::write::FileOptions::default())
            .unwrap();
        zip.write_all(&content).unwrap();
    }
    zip.finish().unwrap();
    success(cli(
        root,
        &["project.zip", "--main", "paper/main.tex", "--offline"],
    ));
    pdf(&root.join("main.pdf"));

    let invalid =
        "\\documentclass{article}\n\\begin{document}\n\\undefinedTachyonCommand\n\\end{document}\n";
    fs::write(root.join("bad.tex"), invalid).unwrap();
    let previous_pdf = fs::read(root.join("output/report.pdf")).unwrap();
    let failed = cli(root, &["bad.tex", "-o", "output/report.pdf", "--offline"]);
    assert_eq!(failed.status.code(), Some(1));
    assert!(String::from_utf8_lossy(&failed.stderr).contains("Undefined control sequence"));
    assert_eq!(fs::read_to_string(root.join("bad.tex")).unwrap(), invalid);
    assert_eq!(
        fs::read(root.join("output/report.pdf")).unwrap(),
        previous_pdf
    );
    // Missing end{document} must fail instead of silently editing the source.
    let incomplete = "\\documentclass{article}\n\\begin{document}Incomplete\n";
    fs::write(root.join("incomplete.tex"), incomplete).unwrap();
    assert!(!cli(root, &["incomplete.tex", "--offline"]).status.success());
    assert_eq!(
        fs::read_to_string(root.join("incomplete.tex")).unwrap(),
        incomplete
    );
    assert!(!root.join("incomplete.pdf").exists());
}

#[test]
fn bibtex_and_local_graphics_compile() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    // Tiny RGB PNG fixture, embedded to avoid any external image tool.
    let png: &[u8] = &[
        137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1, 8, 2,
        0, 0, 0, 144, 119, 83, 222, 0, 0, 0, 12, 73, 68, 65, 84, 8, 215, 99, 248, 207, 192, 0, 0,
        3, 1, 1, 0, 24, 221, 141, 176, 0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130,
    ];
    fs::write(root.join("figure.png"), png).unwrap();
    fs::write(root.join("refs.bib"), "@book{knuth, author={Donald Knuth}, title={The TeXbook}, year={1984}, publisher={Addison-Wesley}}\n").unwrap();
    fs::write(root.join("paper.tex"), "\\documentclass{article}\n\\usepackage{graphicx}\n\\begin{document}\nCitation \\cite{knuth}.\\includegraphics[width=1cm]{figure.png}\n\\bibliographystyle{plain}\\bibliography{refs}\n\\end{document}\n").unwrap();
    success(cli(root, &["paper.tex", "--keep-intermediates"]));
    pdf(&root.join("paper.pdf"));
    let bibliography = fs::read_to_string(root.join("paper.bbl")).unwrap();
    assert!(bibliography.contains("Knuth"));
}

#[cfg(windows)]
#[test]
fn portable_executable_finds_windows_fonts_without_latex_on_path() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    let executable = root.join("tachyon-tex.exe");
    fs::copy(env!("CARGO_BIN_EXE_tachyon-tex"), &executable).unwrap();
    fs::write(root.join("fuente á.tex"), "\\documentclass{article}\n\\usepackage{fontspec}\n\\setmainfont{Arial}\n\\begin{document}Windows Arial font\\end{document}\n").unwrap();
    let system_path = Path::new(&std::env::var_os("SystemRoot").unwrap()).join("System32");
    let run = |offline: bool| {
        let mut process = Command::new(&executable);
        process
            .current_dir(root)
            .env("TACHYON_NO_UPDATE_CHECK", "1")
            .env("PATH", &system_path)
            .env_remove("FONTCONFIG_FILE")
            .env_remove("FONTCONFIG_PATH")
            .args(["fuente á.tex", "--keep-logs"]);
        if offline {
            process.arg("--offline");
        }
        let output = process.output().unwrap();
        assert!(
            !String::from_utf8_lossy(&output.stderr).contains("Cannot load default config file")
        );
        success(output);
        pdf(&root.join("fuente á.pdf"));
        assert!(fs::read_to_string(root.join("fuente á.log"))
            .unwrap()
            .to_lowercase()
            .contains("arial"));
    };
    run(false);
    run(true);
}
