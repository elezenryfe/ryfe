//! Local git, with a leash on it.
//!
//! The design decision that matters here: **there is no "run this git command"
//! command.** The front end picks from a fixed catalogue of actions, and each one
//! has its argv written out below. A value can come from the UI (a path, a
//! message, a branch name) but it is only ever slotted into a slot that already
//! exists, and anything starting with `-` is rejected so it cannot turn into a
//! flag. That closes off both command injection and "oops, I passed --force".
//!
//! Every action also carries a risk level, and the destructive ones require the
//! caller to echo back the repository's own folder name. That check lives here,
//! in Rust, not in the UI — a UI check is a suggestion, this one is a wall.

use std::path::{Path, PathBuf};
use std::process::Command;

use serde::Serialize;

/// Folders never worth showing as a project of their own — caches, build
/// output, dependency trees.
const SKIP: &[&str] = &[
    "node_modules", "target", "dist", "build", "out", ".next", ".nuxt", ".venv", "venv",
    "env", "__pycache__", ".cache", ".gradle", ".idea", "vendor", "Pods", ".tox",
];

/// Git output beyond this is truncated. A diff of a 40 MB lockfile should not
/// be able to freeze the island.
const MAX_OUTPUT: usize = 512 * 1024;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

#[derive(Serialize, Clone, Debug)]
pub struct Repo {
    /// Absolute path, with forward slashes.
    pub path: String,
    pub name: String,
    /// The configured root it was found under, for grouping in the list.
    pub root: String,
    /// Number of changed files, or None if it could not be read.
    pub dirty: Option<u32>,
    /// False for a folder listed only because it is not under git yet.
    pub has_git: bool,
}

#[derive(Serialize, Clone, Debug)]
pub struct FileChange {
    pub path: String,
    /// modified | added | deleted | renamed | untracked | conflicted | typechange
    pub kind: String,
    /// True when the change is in the index rather than only the working tree.
    pub staged: bool,
    pub add: u32,
    pub del: u32,
}

#[derive(Serialize, Clone, Debug, Default)]
pub struct RepoStatus {
    pub branch: String,
    pub upstream: String,
    /// The origin URL, or empty when there is no remote at all.
    pub remote: String,
    /// False on a branch with nothing committed yet, which is what makes a push
    /// pointless rather than merely uninteresting.
    pub has_commits: bool,
    pub ahead: u32,
    pub behind: u32,
    pub files: Vec<FileChange>,
}

#[derive(Serialize, Clone, Debug)]
pub struct GitOutput {
    /// The exact command line that ran, for showing to the user.
    pub command: String,
    /// Whether git exited 0. A failure is still Ok, with the reason in stderr.
    pub ok: bool,
    pub stdout: String,
    pub stderr: String,
}

#[derive(Serialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum Risk {
    /// Runs on its own, as often as needed.
    Read,
    /// Changes the repository, but only in ways that are easy to undo.
    Write,
    /// Can lose work. Needs the repository name typed out.
    Destructive,
}

// ---------------------------------------------------------------------------
// Running git
// ---------------------------------------------------------------------------

fn base_command(repo: &Path) -> Command {
    let mut cmd = Command::new("git");
    cmd.arg("-C").arg(repo);
    // No pager, no colour codes, no credential prompts hanging the process.
    cmd.env("GIT_TERMINAL_PROMPT", "0");
    cmd.env("GIT_PAGER", "cat");
    cmd.env("GIT_OPTIONAL_LOCKS", "0");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // Without this, every git call flashes a console window on screen.
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

fn truncate(mut s: String) -> String {
    if s.len() > MAX_OUTPUT {
        // Cut on a character boundary, or the String is invalid.
        let mut cut = MAX_OUTPUT;
        while cut > 0 && !s.is_char_boundary(cut) {
            cut -= 1;
        }
        s.truncate(cut);
        s.push_str("\n… output truncated");
    }
    s
}

/// Runs git and returns its stdout, or the stderr as the error.
fn run_blocking(repo: PathBuf, args: Vec<String>) -> Result<String, String> {
    let out = base_command(&repo)
        .args(&args)
        .output()
        .map_err(|e| format!("could not run git (is it on your PATH?): {e}"))?;

    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(if err.is_empty() {
            format!("git exited with {}", out.status)
        } else {
            err
        });
    }
    Ok(truncate(String::from_utf8_lossy(&out.stdout).to_string()))
}

/// Runs a read-only git command, for callers that are not the UI — the
/// assistant's tools. Write actions deliberately have no equivalent here.
pub async fn run_read(repo: &str, args: Vec<String>) -> Result<String, String> {
    let path = require_repo(repo)?;
    tauri::async_runtime::spawn_blocking(move || run_blocking(path, args))
        .await
        .map_err(|e| format!("git task failed: {e}"))?
}

/// Renders argv the way the user would type it, for the confirmation line.
fn render(repo: &str, args: &[String]) -> String {
    let mut line = format!("git -C {} ", quote(repo));
    line.push_str(&args.iter().map(|a| quote(a)).collect::<Vec<_>>().join(" "));
    line
}

fn quote(s: &str) -> String {
    if s.is_empty() {
        return "\"\"".to_string();
    }
    if s.chars().any(|c| c.is_whitespace() || "\"'$`\\".contains(c)) {
        format!("\"{}\"", s.replace('\\', "\\\\").replace('"', "\\\""))
    } else {
        s.to_string()
    }
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

fn is_repo(dir: &Path) -> bool {
    // A worktree's .git is a file; a normal checkout's is a directory.
    dir.join(".git").exists()
}

/// The immediate child folders of a root, each with its own git state.
///
/// One row per folder, deliberately not recursive: a checkout nested inside a
/// project is a part of that project, not a project of its own, and a list that
/// mixes the two is a list nobody can scan. So `transcriber/frontend` never
/// appears — `transcriber` does, and says whether *it* is under git.
fn top_level(root: &Path, root_label: &str) -> Vec<Repo> {
    let mut rows = Vec::new();
    let Ok(entries) = std::fs::read_dir(root) else {
        return rows;
    };
    for entry in entries.flatten() {
        // A root pointed at something enormous still has to answer quickly.
        if rows.len() >= 200 {
            break;
        }
        let child = entry.path();
        let Ok(kind) = entry.file_type() else { continue };
        if !kind.is_dir() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        // Hidden folders are caches by convention; `.git` belongs to a folder
        // rather than being one.
        if name.starts_with('.') || SKIP.contains(&name.as_str()) {
            continue;
        }
        let has_git = is_repo(&child);
        rows.push(Repo {
            path: child.to_string_lossy().replace('\\', "/"),
            name,
            root: root_label.to_string(),
            // A plain folder has no git to ask.
            dirty: if has_git { dirty_count(&child) } else { None },
            has_git,
        });
    }
    rows
}

/// The number of changed files, or None if git could not be asked.
fn dirty_count(repo: &Path) -> Option<u32> {
    let out = base_command(repo)
        .args(["status", "--porcelain"])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    Some(
        String::from_utf8_lossy(&out.stdout)
            .lines()
            .filter(|l| !l.trim().is_empty())
            .count() as u32,
    )
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

fn kind_for(xy: &str) -> &'static str {
    // Porcelain v2: X is the index, Y is the working tree. Either can be '.'.
    let c = xy.chars().find(|c| *c != '.').unwrap_or('.');
    match c {
        'A' => "added",
        'D' => "deleted",
        'R' | 'C' => "renamed",
        'T' => "typechange",
        'M' => "modified",
        _ => "modified",
    }
}

/// `git diff --numstat` keyed by path, so the +/- counts can be merged in.
fn numstat(repo: &Path, staged: bool) -> std::collections::HashMap<String, (u32, u32)> {
    let mut args = vec!["diff", "--numstat"];
    if staged {
        args.push("--cached");
    }
    let Ok(out) = base_command(repo).args(&args).output() else {
        return Default::default();
    };
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .filter_map(|line| {
            let mut parts = line.split('\t');
            let add = parts.next()?;
            let del = parts.next()?;
            let path = parts.next()?;
            // Binaries report "-" instead of a number.
            Some((
                path.to_string(),
                (add.parse().unwrap_or(0), del.parse().unwrap_or(0)),
            ))
        })
        .collect()
}

fn parse_status(text: &str, staged_counts: &std::collections::HashMap<String, (u32, u32)>,
                work_counts: &std::collections::HashMap<String, (u32, u32)>) -> RepoStatus {
    let mut status = RepoStatus::default();

    for line in text.lines() {
        if let Some(rest) = line.strip_prefix("# branch.oid ") {
            // "(initial)" is a branch that has not been committed to yet.
            status.has_commits = rest.trim() != "(initial)";
        } else if let Some(rest) = line.strip_prefix("# branch.head ") {
            status.branch = rest.trim().to_string();
        } else if let Some(rest) = line.strip_prefix("# branch.upstream ") {
            status.upstream = rest.trim().to_string();
        } else if let Some(rest) = line.strip_prefix("# branch.ab ") {
            // "+2 -0"
            for part in rest.split_whitespace() {
                if let Some(n) = part.strip_prefix('+') {
                    status.ahead = n.parse().unwrap_or(0);
                } else if let Some(n) = part.strip_prefix('-') {
                    status.behind = n.parse().unwrap_or(0);
                }
            }
        } else if let Some(rest) = line.strip_prefix("1 ") {
            // 1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>
            let mut it = rest.splitn(8, ' ');
            let xy = it.next().unwrap_or("..");
            let path = it.nth(6).unwrap_or("").to_string();
            push_change(&mut status, path, xy, staged_counts, work_counts);
        } else if let Some(rest) = line.strip_prefix("2 ") {
            // 2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <X><score> <path>\t<origPath>
            let mut it = rest.splitn(9, ' ');
            let xy = it.next().unwrap_or("..");
            let path = it.nth(7).unwrap_or("").split('\t').next().unwrap_or("").to_string();
            push_change(&mut status, path, xy, staged_counts, work_counts);
        } else if let Some(rest) = line.strip_prefix("u ") {
            // Unmerged. Nothing sensible to stage, but it must be visible.
            let path = rest.splitn(10, ' ').nth(9).unwrap_or("").to_string();
            status.files.push(FileChange {
                path,
                kind: "conflicted".to_string(),
                staged: false,
                add: 0,
                del: 0,
            });
        } else if let Some(path) = line.strip_prefix("? ") {
            status.files.push(FileChange {
                path: path.to_string(),
                kind: "untracked".to_string(),
                staged: false,
                add: 0,
                del: 0,
            });
        }
    }

    status
}

fn push_change(
    status: &mut RepoStatus,
    path: String,
    xy: &str,
    staged_counts: &std::collections::HashMap<String, (u32, u32)>,
    work_counts: &std::collections::HashMap<String, (u32, u32)>,
) {
    let mut chars = xy.chars();
    let index = chars.next().unwrap_or('.');
    let work = chars.next().unwrap_or('.');

    let staged = index != '.';
    let (add, del) = if staged {
        staged_counts.get(&path).copied().unwrap_or((0, 0))
    } else {
        work_counts.get(&path).copied().unwrap_or((0, 0))
    };

    // A file can be changed in both places. The working tree is what the user
    // is about to commit, so it wins; the index state is reported on its own
    // row when only the index changed.
    let kind = if staged && work == '.' {
        kind_for(&index.to_string())
    } else if work != '.' {
        kind_for(&work.to_string())
    } else {
        kind_for(&index.to_string())
    };

    status.files.push(FileChange {
        path,
        kind: kind.to_string(),
        staged,
        add,
        del,
    });
}

// ---------------------------------------------------------------------------
// The catalogue
// ---------------------------------------------------------------------------

/// Rejects a value that could stop being an argument and start being a flag.
///
/// This is the whole defence against the UI handing git something like
/// `--upload-pack=...`: a path or a branch name is only ever placed after an
/// explicit separator, and a leading `-` never gets that far.
fn safe_arg(s: &str) -> Result<&str, ()> {
    if s.is_empty() || s.starts_with('-') || s.contains('\0') || s.contains('\n') {
        Err(())
    } else {
        Ok(s)
    }
}

/// The nth argument from the UI, checked. A free function rather than a closure
/// so the returned borrow can be tied to `args`.
fn need(args: &[String], i: usize) -> Option<&str> {
    args.get(i).and_then(|s| safe_arg(s).ok())
}

/// What each action does, and how dangerous it is.
///
/// Returning `None` is a refusal, and the front end can only ever ask for the
/// names listed here.
fn argv_for(action: &str, args: &[String]) -> Option<(Vec<String>, Risk)> {
    let s = |v: &str| v.to_string();

    Some(match action {
        // --- read ---------------------------------------------------------
        "status" => (vec![s("status"), s("--porcelain=v2"), s("--branch")], Risk::Read),
        "log" => (
            vec![s("log"), s("--oneline"), s("--decorate"), s("-n"), s("30")],
            Risk::Read,
        ),
        "branches" => (vec![s("branch"), s("--list"), s("--no-color")], Risk::Read),
        "remotes" => (vec![s("remote"), s("-v")], Risk::Read),
        "diff_file" => {
            let mut v = vec![s("diff"), s("--no-color")];
            if !args.is_empty() {
                v.push(s("--"));
                v.push(need(args, 0)?.to_string());
            }
            (v, Risk::Read)
        }
        "diff_staged" => (vec![s("diff"), s("--cached"), s("--no-color")], Risk::Read),
        "show" => (vec![s("show"), s("--stat"), s("--no-color"), s("HEAD")], Risk::Read),

        // --- write --------------------------------------------------------
        "stage_all" => (vec![s("add"), s("-A")], Risk::Write),
        "stage_file" => (vec![s("add"), s("--"), need(args, 0)?.to_string()], Risk::Write),
        "unstage_file" => (
            vec![s("restore"), s("--staged"), s("--"), need(args, 0)?.to_string()],
            Risk::Write,
        ),
        "unstage_all" => (vec![s("restore"), s("--staged"), s("--"), s(".")], Risk::Write),
        "unstage_new" => {
            // Unstaging on a branch with no commits: there is no HEAD to restore
            // from, so the files come back out of the index instead. No path at
            // all means every one of them — but a path that is refused must not
            // quietly become "all of them".
            let path = match args.first() {
                None => ".".to_string(),
                Some(_) => need(args, 0)?.to_string(),
            };
            (
                vec![s("rm"), s("-r"), s("--cached"), s("-q"), s("--"), path],
                Risk::Write,
            )
        }
        "commit" => {
            // A message is required, and a blank one is not a commit.
            let msg = need(args, 0)?;
            if msg.trim().is_empty() {
                return None;
            }
            (vec![s("commit"), s("-m"), s(msg)], Risk::Write)
        }
        "commit_all" => {
            let msg = need(args, 0)?;
            if msg.trim().is_empty() {
                return None;
            }
            // -a only reaches tracked files; untracked ones need the add, which
            // the pair below performs.
            (vec![s("commit"), s("-a"), s("-m"), s(msg)], Risk::Write)
        }
        "init" => (vec![s("init"), s("-b"), s("main")], Risk::Write),
        "remote_add" => {
            // https only: `ext::sh -c …` is a real git transport, and a stored
            // remote URL is executed by the next fetch or push.
            let url = need(args, 0)?;
            if !url.starts_with("https://") {
                return None;
            }
            (vec![s("remote"), s("add"), s("origin"), url.to_string()], Risk::Write)
        }
        "push" => (vec![s("push")], Risk::Write),
        "push_upstream" => (
            vec![s("push"), s("--set-upstream"), s("origin"), need(args, 0)?.to_string()],
            Risk::Write,
        ),
        "pull" => (vec![s("pull")], Risk::Write),
        "fetch" => (vec![s("fetch"), s("--all"), s("--prune")], Risk::Write),
        "branch_create" => (vec![s("switch"), s("-c"), need(args, 0)?.to_string()], Risk::Write),
        "branch_switch" => (vec![s("switch"), need(args, 0)?.to_string()], Risk::Write),
        "stash_push" => (vec![s("stash"), s("push")], Risk::Write),
        "stash_pop" => (vec![s("stash"), s("pop")], Risk::Write),

        // --- destructive --------------------------------------------------
        "push_force" => (vec![s("push"), s("--force-with-lease")], Risk::Destructive),
        "reset_hard" => (vec![s("reset"), s("--hard"), s("HEAD")], Risk::Destructive),
        "clean_fd" => (vec![s("clean"), s("-fd")], Risk::Destructive),
        "branch_delete" => (vec![s("branch"), s("-D"), need(args, 0)?.to_string()], Risk::Destructive),
        "discard_file" => (
            vec![s("restore"), s("--"), need(args, 0)?.to_string()],
            Risk::Destructive,
        ),

        _ => return None,
    })
}

fn folder_name(repo: &str) -> String {
    Path::new(repo)
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default()
}

fn require_repo(repo: &str) -> Result<PathBuf, String> {
    let p = PathBuf::from(repo);
    if !is_repo(&p) {
        return Err(format!("{repo} is not a git repository"));
    }
    Ok(p)
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// Every top-level folder under the configured roots, with a cheap
/// changed-file count for the ones that are repositories.
#[tauri::command]
pub async fn git_repos(roots: Vec<String>) -> Result<Vec<Repo>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut found = Vec::new();
        for root in &roots {
            let path = Path::new(root);
            if path.is_dir() {
                found.extend(top_level(path, root));
            }
        }
        found.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
        found
    })
    .await
    .map_err(|e| format!("discovery failed: {e}"))
}


/// Full status for one repository.
#[tauri::command]
pub async fn git_status(repo: String) -> Result<RepoStatus, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = require_repo(&repo)?;
        let raw = run_blocking(
            path.clone(),
            vec![
                "status".to_string(),
                "--porcelain=v2".to_string(),
                "--branch".to_string(),
            ],
        )?;
        let staged = numstat(&path, true);
        let work = numstat(&path, false);
        let mut status = parse_status(&raw, &staged, &work);
        // `git remote get-url` exits 2 when there is no such remote, so this is
        // asked and discarded rather than put through run_blocking.
        status.remote = base_command(&path)
            .args(["remote", "get-url", "origin"])
            .output()
            .ok()
            .filter(|out| out.status.success())
            .map(|out| String::from_utf8_lossy(&out.stdout).trim().to_string())
            .unwrap_or_default();
        Ok(status)
    })
    .await
    .map_err(|e| format!("status failed: {e}"))?
}

/// The diff for one file, or for the whole index.
#[tauri::command]
pub async fn git_diff(repo: String, path: Option<String>, staged: bool) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let repo_path = require_repo(&repo)?;
        let mut args = vec!["diff".to_string(), "--no-color".to_string()];
        if staged {
            args.push("--cached".to_string());
        }
        if let Some(p) = path {
            args.push("--".to_string());
            args.push(p);
        }
        run_blocking(repo_path, args)
    })
    .await
    .map_err(|e| format!("diff failed: {e}"))?
}

/// What connecting this folder would publish, asked before anything is staged.
#[derive(Serialize, Clone, Debug, Default)]
pub struct PublishCheck {
    /// Every file that would be committed. Counted with `-uall`, because plain
    /// `git status` collapses a folder of dependencies into one line.
    pub files: u32,
    /// Unresolved merges, which cannot be committed at all.
    pub conflicts: u32,
    /// Files that hold secrets by convention, about to be committed for good.
    pub env_files: Vec<String>,
    /// The top-level folder holding the most of them, so a refusal can say
    /// which one to ignore rather than leaving the user to guess.
    pub heaviest: String,
    /// Folders that are repositories in their own right. Git records a pointer
    /// to one of these instead of its files, so publishing the folder above it
    /// would silently leave them behind.
    pub embedded: Vec<String>,
}

/// `.env`, `.env.local`, `config/.env` — the names secrets actually use. The
/// templates are not secrets, and refusing them would block an ordinary project.
fn is_env(path: &str) -> bool {
    let name = path.rsplit('/').next().unwrap_or(path);
    name == ".env"
        || (name.starts_with(".env.")
            && !matches!(name, ".env.example" | ".env.sample" | ".env.template"))
}

/// Reads porcelain v1 into the check. Separate from the command so it can be
/// tested against what git actually prints.
fn parse_publish_check(raw: &str) -> PublishCheck {
    let mut check = PublishCheck::default();
    let mut per_dir: std::collections::HashMap<&str, u32> = std::collections::HashMap::new();
    for line in raw.lines() {
        // porcelain v1 is "XY PATH", and renames are "OLD -> NEW".
        let Some(xy) = line.get(0..2) else { continue };
        let Some(rest) = line.get(3..) else { continue };
        let path = rest.rsplit(" -> ").next().unwrap_or(rest).trim();
        if path.is_empty() {
            continue;
        }
        check.files += 1;
        if xy.contains('U') || xy == "DD" || xy == "AA" {
            check.conflicts += 1;
        }
        // With -uall git expands untracked folders into the files inside them —
        // except a folder that is itself a repository, which it keeps as a
        // single entry wearing a trailing slash.
        if path.ends_with('/') {
            check.embedded.push(path.trim_end_matches('/').to_string());
        } else if is_env(path) {
            check.env_files.push(path.to_string());
        }
        *per_dir.entry(path.split('/').next().unwrap_or(path)).or_insert(0) += 1;
    }
    check.heaviest = per_dir
        .into_iter()
        .max_by_key(|(_, n)| *n)
        .map(|(dir, _)| dir.to_string())
        .unwrap_or_default();
    check
}

/// Looks at what publishing this folder would mean. Read-only, and safe to run
/// on a folder that has just been `init`ed.
#[tauri::command]
pub async fn git_publish_check(repo: String) -> Result<PublishCheck, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = require_repo(&repo)?;
        // run_blocking cuts long output at MAX_OUTPUT, so this counts what it
        // can see — which is enough to tell a project from a dependency tree.
        let raw = run_blocking(
            path,
            vec![
                "status".to_string(),
                "--porcelain".to_string(),
                "-uall".to_string(),
            ],
        )?;

        Ok(parse_publish_check(&raw))
    })
    .await
    .map_err(|e| format!("check failed: {e}"))?
}

/// What a git action would run, without running it. This is what the
/// confirmation card shows.
#[tauri::command]
pub fn git_preview(repo: String, action: String, args: Vec<String>) -> Result<(String, Risk), String> {
    let (argv, risk) = argv_for(&action, &args)
        .ok_or_else(|| format!("'{action}' is not something Ryfe can run"))?;
    Ok((render(&repo, &argv), risk))
}

/// Runs one action from the catalogue.
///
/// Destructive actions additionally require `confirm` to equal the repository's
/// folder name. That is checked here rather than in the page, because a check in
/// the page is a suggestion and this one is a wall.
#[tauri::command]
pub async fn git_run(
    repo: String,
    action: String,
    args: Vec<String>,
    confirm: String,
) -> Result<GitOutput, String> {
    let (argv, risk) = argv_for(&action, &args)
        .ok_or_else(|| format!("'{action}' is not something Ryfe can run"))?;

    if risk == Risk::Destructive {
        let expected = folder_name(&repo);
        if confirm.trim() != expected {
            return Err(format!(
                "this one can lose work — type the repository name ({expected}) to confirm"
            ));
        }
    }

    let shown = render(&repo, &argv);

    tauri::async_runtime::spawn_blocking(move || {
        // `init` is the one action that runs where there is no repository yet.
        let path = if action == "init" {
            let path = PathBuf::from(&repo);
            if !path.is_dir() {
                return Err(format!("{repo} is not a folder"));
            }
            path
        } else {
            require_repo(&repo)?
        };
        let out = base_command(&path)
            .args(&argv)
            .output()
            .map_err(|e| format!("could not run git: {e}"))?;

        let ok = out.status.success();
        let stdout = truncate(String::from_utf8_lossy(&out.stdout).to_string());
        let stderr = truncate(String::from_utf8_lossy(&out.stderr).to_string());

        // git puts "nothing to commit" on stdout and exits 1; that is a normal
        // outcome to report, not an error to swallow. `ok` lets a caller that
        // runs several actions in a row stop at the first that failed.
        Ok(GitOutput {
            command: shown,
            ok,
            stdout,
            stderr,
        })
    })
    .await
    .map_err(|e| format!("git task failed: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn argv(action: &str, args: &[&str]) -> Option<Vec<String>> {
        let args: Vec<String> = args.iter().map(|a| a.to_string()).collect();
        argv_for(action, &args).map(|(argv, _)| argv)
    }

    #[test]
    fn the_connect_actions_render_the_expected_commands() {
        assert_eq!(argv("init", &[]).unwrap(), vec!["init", "-b", "main"]);
        assert_eq!(
            argv("remote_add", &["https://github.com/me/thing.git"]).unwrap(),
            vec!["remote", "add", "origin", "https://github.com/me/thing.git"]
        );
    }

    #[test]
    fn remote_add_only_accepts_https() {
        // ext:: is a real git transport, and a stored remote URL is executed by
        // the next fetch or push.
        assert!(argv("remote_add", &["ext::sh -c whoami"]).is_none());
        assert!(argv("remote_add", &["git@github.com:me/thing.git"]).is_none());
        assert!(argv("remote_add", &["-o"]).is_none());
        assert!(argv("remote_add", &[]).is_none());
    }

    /// Runs real git, because the whole point of `-uall` is invisible to the
    /// parser: without it a folder of dependencies counts as one line.
    #[test]
    fn publish_check_counts_every_file_and_finds_the_env() {
        let dir = std::env::temp_dir().join("ryfe-publish-check-test");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("node_modules/left-pad")).unwrap();
        std::fs::write(dir.join("node_modules/left-pad/index.js"), "x").unwrap();
        std::fs::write(dir.join("node_modules/left-pad/package.json"), "x").unwrap();
        std::fs::write(dir.join(".env"), "SECRET=1").unwrap();
        std::fs::write(dir.join("main.ts"), "x").unwrap();
        // A checkout inside the folder: git points at it rather than carrying it.
        let sibling = dir.join("sibling-repo");
        std::fs::create_dir_all(&sibling).unwrap();
        assert!(
            Command::new("git")
                .arg("-C")
                .arg(&sibling)
                .args(["init", "-b", "main"])
                .output()
                .unwrap()
                .status
                .success()
        );

        let init = Command::new("git")
            .arg("-C")
            .arg(&dir)
            .args(["init", "-b", "main"])
            .output()
            .expect("git should be on PATH");
        assert!(init.status.success());

        let status = |extra: &[&str]| -> String {
            let mut args = vec!["-C", dir.to_str().unwrap(), "status", "--porcelain"];
            args.extend_from_slice(extra);
            let out = Command::new("git").args(&args).output().unwrap();
            String::from_utf8_lossy(&out.stdout).to_string()
        };

        let collapsed = parse_publish_check(&status(&[]));
        let every = parse_publish_check(&status(&["-uall"]));

        assert_eq!(collapsed.files, 4, "plain status hides the dependency folder");
        assert_eq!(every.files, 5, "-uall counts what git add -A would commit");
        assert!(every.env_files.contains(&".env".to_string()));
        assert_eq!(every.conflicts, 0);
        assert_eq!(every.heaviest, "node_modules", "the refusal names the folder to ignore");
        assert_eq!(
            every.embedded,
            vec!["sibling-repo"],
            "a checkout inside the folder is called out"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn env_files_are_recognised_by_name_at_any_depth() {
        assert!(is_env(".env"));
        assert!(is_env(".env.local"));
        assert!(is_env("server/.env"));
        assert!(!is_env("env"));
        assert!(!is_env("src/environment.ts"));
        assert!(!is_env("docs/.env.example"));
    }

    #[test]
    fn unstaging_has_a_command_for_both_kinds_of_branch() {
        assert_eq!(
            argv("unstage_all", &[]).unwrap(),
            vec!["restore", "--staged", "--", "."]
        );
        assert_eq!(
            argv("unstage_new", &[]).unwrap(),
            vec!["rm", "-r", "--cached", "-q", "--", "."],
            "no path un-stages everything"
        );
        assert_eq!(
            argv("unstage_new", &["src/a.ts"]).unwrap(),
            vec!["rm", "-r", "--cached", "-q", "--", "src/a.ts"]
        );
        assert!(
            argv("unstage_new", &["--force"]).is_none(),
            "a path that is really a flag never gets through"
        );
    }

    #[test]
    fn an_unborn_branch_says_it_has_no_commits() {
        let empty = std::collections::HashMap::new();
        let none = parse_status(
            "# branch.oid (initial)\n# branch.head main\n",
            &empty,
            &empty,
        );
        assert!(!none.has_commits, "a push would have nothing to send");
        assert_eq!(none.branch, "main");

        let some = parse_status(
            "# branch.oid 89cb218b74b07c87042b0f3d58ae44069634bd12\n# branch.head master\n",
            &empty,
            &empty,
        );
        assert!(some.has_commits);
    }

    #[test]
    fn only_the_root_folders_are_listed() {
        let dir = std::env::temp_dir().join("ryfe-top-level-test");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("project/.git")).unwrap();
        std::fs::create_dir_all(dir.join("notes/sub")).unwrap();
        std::fs::create_dir_all(dir.join("nested/inner/.git")).unwrap();
        std::fs::create_dir_all(dir.join("node_modules")).unwrap();

        let rows = top_level(&dir, "test");
        let row = |name: &str| rows.iter().find(|r| r.name == name);

        assert!(row("project").unwrap().has_git, "a folder with .git is a repository");
        assert!(!row("notes").unwrap().has_git, "a folder without one is offered setup");
        assert!(
            !row("nested").unwrap().has_git,
            "a repository below a folder does not make that folder one"
        );
        assert!(
            !rows.iter().any(|r| r.name == "sub" || r.name == "inner"),
            "nothing below the root is ever listed"
        );
        assert!(!rows.iter().any(|r| r.name == "node_modules"), "caches are left out");
        assert_eq!(rows.len(), 3, "one row per folder, and only folders");

        let _ = std::fs::remove_dir_all(&dir);
    }
}
