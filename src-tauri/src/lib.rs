// Sisyphus desktop shell.
//
// Phase-1 (M22) responsibilities are intentionally minimal:
//   1. On startup, spawn the daemon as a child process so the user
//      doesn't have to run it in a separate terminal.
//   2. Poll the daemon's /health until it responds, then reload the
//      webview so it doesn't sit on a "connection refused" page.
//   3. Open the main window pointing at http://localhost:8787 — the
//      same URL the web-deploy form uses; daemon serves UI + API + WS.
//   4. On shutdown, kill the daemon child cleanly.
//
// Phase-2 will replace the `pnpm` spawn with a bundled sidecar binary
// so the .app/.dmg distribution doesn't require Node + pnpm + workspace
// source on disk.
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::Duration;

use tauri::Manager;

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

fn spawn_daemon() -> std::io::Result<Child> {
    let root = workspace_root();
    log::info!("[sisyphus] spawning daemon at {}", root.display());
    Command::new("pnpm")
        .args(["--filter", "@sisyphus/daemon", "start"])
        .current_dir(&root)
        .env(
            "SISYPHUS_UI_DIR",
            root.join("packages/ui/dist").to_string_lossy().to_string(),
        )
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .spawn()
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
            let child = spawn_daemon()
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
