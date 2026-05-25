// Sisyphus desktop shell.
//
// Responsibilities:
//   1. On startup, spawn the daemon as a child process so the user
//      doesn't have to run it in a separate terminal.
//   2. Poll the daemon's /health until it responds, then reload the
//      webview so it doesn't sit on a "connection refused" page.
//   3. Open the main window pointing at http://localhost:8787 — the
//      same URL the web-deploy form uses; daemon serves UI + API + WS.
//   4. On shutdown, kill the daemon child cleanly.
//
// Daemon source resolution:
//   - Prefer the bundled sidecar binary (`sisyphus-daemon[-<triple>]`)
//     placed next to the current exe by Tauri. This is the prod path
//     for .app/.dmg distribution and the default when `cargo tauri dev`
//     has copied the externalBin into `target/{debug,release}/`.
//   - Fall back to `src-tauri/binaries/sisyphus-daemon-<triple>` for
//     when the binary was built via `pnpm --filter @sisyphus/daemon
//     build:bin` but not yet picked up by tauri's build pipeline.
//   - Fall back to `pnpm --filter @sisyphus/daemon start` so fresh
//     clones can still `cargo tauri dev` without running build:bin
//     first.
//
// UI directory resolution (M22 phase-2.5):
//   - In prod (.app bundle), `packages/ui/dist` is shipped under
//     `Sisyphus.app/Contents/Resources/ui/`. We resolve it via
//     `app.path().resource_dir().join("ui")` and forward it to the
//     daemon as `SISYPHUS_UI_DIR` so the daemon's static handler can
//     serve `index.html` + hashed assets.
//   - In dev (`cargo tauri dev`), Tauri may not stage resources; fall
//     back to the monorepo's `packages/ui/dist`.
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::Duration;

use tauri::{App, Manager};

const DAEMON_HEALTH_URL: &str = "http://localhost:8787/health";
const DAEMON_BOOT_TIMEOUT_SECS: u64 = 30;
const DAEMON_POLL_INTERVAL_MS: u64 = 200;

/// Where the monorepo lives at compile time. Works in dev (`cargo tauri
/// dev`). Phase-2 will swap this for resource-path resolution against
/// a bundled sidecar.
fn workspace_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("src-tauri must live one level below the workspace root")
        .to_path_buf()
}

/// Look in `dir` for a file named `sisyphus-daemon` or
/// `sisyphus-daemon-<anything>` (Tauri suffixes externalBin copies with
/// the rust target triple in dev; the prod bundle drops the suffix).
fn find_sidecar_in(dir: &Path) -> Option<PathBuf> {
    let entries = std::fs::read_dir(dir).ok()?;
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name_s = name.to_string_lossy();
        if name_s == "sisyphus-daemon" || name_s.starts_with("sisyphus-daemon-") {
            let path = entry.path();
            if path.is_file() {
                return Some(path);
            }
        }
    }
    None
}

fn locate_daemon_sidecar() -> Option<PathBuf> {
    if let Some(dir) = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(Path::to_path_buf))
    {
        if let Some(found) = find_sidecar_in(&dir) {
            return Some(found);
        }
    }
    let dev_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("binaries");
    find_sidecar_in(&dev_dir)
}

/// Find the UI dir to forward to the daemon as `SISYPHUS_UI_DIR`.
/// Prod: bundled under `<resources>/ui/`. Dev fallback: monorepo `packages/ui/dist`.
fn locate_ui_dir(app: &App) -> Option<PathBuf> {
    if let Ok(resource_dir) = app.path().resource_dir() {
        let candidate = resource_dir.join("ui");
        if candidate.join("index.html").exists() {
            return Some(candidate);
        }
    }
    let dev_candidate = workspace_root().join("packages/ui/dist");
    if dev_candidate.join("index.html").exists() {
        return Some(dev_candidate);
    }
    None
}

/// Choose a working directory for the spawned daemon.
///   - In dev (cargo tauri dev / build run from a checkout), workspace_root()
///     exists — use it so daemon picks up the repo's .env/.env.local.
///   - In a shipped .app, workspace_root() refers to the dev machine and
///     doesn't exist on the user's box; fall back to $HOME so spawn() doesn't
///     fail with ENOENT. The daemon will silently skip the missing .env files.
fn pick_daemon_cwd() -> PathBuf {
    let root = workspace_root();
    if root.exists() {
        return root;
    }
    dirs_home_or_root()
}

fn dirs_home_or_root() -> PathBuf {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/"))
}

fn spawn_daemon(app: &App) -> std::io::Result<Child> {
    let cwd = pick_daemon_cwd();
    let mut envs: Vec<(&str, String)> = Vec::new();
    if let Some(ui_dir) = locate_ui_dir(app) {
        log::info!("[sisyphus] forwarding UI dir to daemon: {}", ui_dir.display());
        envs.push(("SISYPHUS_UI_DIR", ui_dir.to_string_lossy().to_string()));
    } else {
        log::warn!("[sisyphus] no UI dir found (resources nor dev fallback); daemon will start without static UI");
    }

    if let Some(sidecar) = locate_daemon_sidecar() {
        log::info!(
            "[sisyphus] spawning daemon sidecar: {} (cwd={})",
            sidecar.display(),
            cwd.display()
        );
        let mut cmd = Command::new(&sidecar);
        cmd.current_dir(&cwd)
            .stdout(Stdio::inherit())
            .stderr(Stdio::inherit());
        for (k, v) in &envs {
            cmd.env(k, v);
        }
        return cmd.spawn();
    }

    log::info!(
        "[sisyphus] no sidecar found; falling back to `pnpm --filter @sisyphus/daemon start` at {}",
        cwd.display()
    );
    let mut cmd = Command::new("pnpm");
    cmd.args(["--filter", "@sisyphus/daemon", "start"])
        .current_dir(&cwd)
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit());
    for (k, v) in &envs {
        cmd.env(k, v);
    }
    cmd.spawn()
}

async fn wait_daemon_ready() -> bool {
    let client = match reqwest::Client::builder()
        .timeout(Duration::from_secs(2))
        .build()
    {
        Ok(c) => c,
        Err(_) => return false,
    };
    let started = std::time::Instant::now();
    while started.elapsed() < Duration::from_secs(DAEMON_BOOT_TIMEOUT_SECS) {
        if let Ok(resp) = client.get(DAEMON_HEALTH_URL).send().await {
            if resp.status().is_success() {
                return true;
            }
        }
        tokio::time::sleep(Duration::from_millis(DAEMON_POLL_INTERVAL_MS)).await;
    }
    false
}

/// Stored on the Tauri AppHandle so the daemon survives any window
/// reopens and gets killed when the app quits.
struct DaemonChild(Mutex<Option<Child>>);

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            // Spawn the daemon and stash the child handle for cleanup.
            let child = spawn_daemon(app)
                .map_err(|e| format!("failed to spawn daemon: {e}"))?;
            app.manage(DaemonChild(Mutex::new(Some(child))));

            // Window already created from tauri.conf with URL = daemon URL.
            // Poll /health in the background; when it responds, reload the
            // webview so the user doesn't get stuck on the initial
            // connection-refused page that may have rendered.
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                if wait_daemon_ready().await {
                    log::info!("[sisyphus] daemon /health ok; reloading webview");
                } else {
                    log::error!(
                        "[sisyphus] daemon /health never responded within {DAEMON_BOOT_TIMEOUT_SECS}s — webview will likely show an error"
                    );
                }
                if let Some(window) = handle.get_webview_window("main") {
                    if let Err(e) = window.eval("window.location.reload()") {
                        log::warn!("[sisyphus] reload after daemon ready failed: {e}");
                    }
                }
            });

            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                if let Some(state) = window.app_handle().try_state::<DaemonChild>() {
                    if let Ok(mut guard) = state.0.lock() {
                        if let Some(mut child) = guard.take() {
                            log::info!("[sisyphus] killing daemon child");
                            let _ = child.kill();
                            let _ = child.wait();
                        }
                    }
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
