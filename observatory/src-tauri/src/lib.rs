// Rust event source for the native app: replaces the O2 dev WS bridge
// (observatory/src/devBridge.mjs) in production. Watches the missions dir
// for the newest missions/<id>/events.jsonl and streams every event line
// (both what's already on disk at startup and everything appended after)
// to the webview via Tauri's event system. The frontend's `tauri` mode in
// eventSource.ts consumes exactly this: a `get_snapshot` command for the
// race-free initial catch-up, a `flota-snapshot` event re-emitted whenever
// the watcher auto-follows a newer mission (so the webview resets its fold
// and seq ceiling instead of mixing two missions together), plus a
// `flota-event` stream for what's new within the current mission.
use notify::{recommended_watcher, RecursiveMode, Watcher};
use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::mpsc::channel;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{Emitter, Manager};

#[derive(Default)]
struct MissionState {
    mission_id: Option<String>,
    events: Vec<serde_json::Value>,
}

// Arc so the watcher thread and Tauri's managed state share the same lock
// (Tauri's `.manage()` doesn't hand back a cloneable handle on its own).
#[derive(Clone, Default)]
struct SharedMissionState(Arc<Mutex<MissionState>>);

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct EventPayload {
    mission_id: String,
    event: serde_json::Value,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct StatusPayload {
    status: &'static str,
    detail: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SnapshotPayload {
    mission_id: Option<String>,
    events: Vec<serde_json::Value>,
}

// Called once by the frontend on mount. Pulling the current state on demand
// (rather than relying on catching every startup `emit`) avoids the race
// where the watcher thread finds a mission and emits before the webview's
// `listen()` has attached — eventSource.ts still buffers events received
// before this resolves and dedupes them against the snapshot by `seq`.
#[tauri::command]
fn get_snapshot(state: tauri::State<SharedMissionState>) -> SnapshotPayload {
    let guard = state.0.lock().unwrap();
    SnapshotPayload {
        mission_id: guard.mission_id.clone(),
        events: guard.events.clone(),
    }
}

// Resolution order: FLOTA_MISSIONS_DIR env var, then walk up from the
// process's cwd looking for a `missions` directory (covers both `npm run
// tauri dev -w observatory` (cwd = observatory/) and a root-level
// invocation (cwd = repo root)), then fall back to a relative `./missions`.
fn resolve_missions_dir() -> PathBuf {
    if let Ok(v) = std::env::var("FLOTA_MISSIONS_DIR") {
        return PathBuf::from(v);
    }
    if let Ok(cwd) = std::env::current_dir() {
        let mut dir = cwd.as_path();
        loop {
            let candidate = dir.join("missions");
            if candidate.is_dir() {
                return candidate;
            }
            match dir.parent() {
                Some(parent) => dir = parent,
                None => break,
            }
        }
    }
    PathBuf::from("missions")
}

// Newest mission by events.jsonl mtime — mirrors devBridge.mjs's
// listMissions()/pickTarget() auto-follow behavior.
fn newest_mission(missions_dir: &Path) -> Option<(String, PathBuf)> {
    let entries = fs::read_dir(missions_dir).ok()?;
    let mut best: Option<(String, PathBuf, std::time::SystemTime)> = None;
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let events_file = path.join("events.jsonl");
        let Ok(metadata) = fs::metadata(&events_file) else {
            continue;
        };
        if !metadata.is_file() {
            continue;
        }
        let Ok(mtime) = metadata.modified() else {
            continue;
        };
        let Some(id) = path.file_name().map(|n| n.to_string_lossy().to_string()) else {
            continue;
        };
        let is_newer = best.as_ref().map(|(_, _, t)| mtime > *t).unwrap_or(true);
        if is_newer {
            best = Some((id, events_file, mtime));
        }
    }
    best.map(|(id, file, _)| (id, file))
}

// Tolerate a truncated/mid-write trailing line rather than dying — same
// guard as devBridge.mjs's parseCompleteLines / EventLog.load.
fn parse_complete_lines(text: &str) -> Vec<serde_json::Value> {
    text.lines()
        .filter(|l| !l.trim().is_empty())
        .filter_map(|l| serde_json::from_str::<serde_json::Value>(l).ok())
        .collect()
}

// Whole-file re-read on every wake (fs-notify event or the 300ms fallback
// poll) rather than incremental byte-offset tracking: mission logs here are
// small, and re-parsing the full file every tick is simple and robust
// against any offset/partial-line bookkeeping bugs.
fn spawn_watcher(app_handle: tauri::AppHandle, shared: SharedMissionState) {
    std::thread::spawn(move || {
        let missions_dir = resolve_missions_dir();
        let _ = app_handle.emit(
            "flota-status",
            StatusPayload {
                status: "connecting",
                detail: Some(format!("watching {}", missions_dir.display())),
            },
        );

        if !missions_dir.exists() {
            let _ = fs::create_dir_all(&missions_dir);
        }

        let (tx, rx) = channel::<notify::Result<notify::Event>>();
        let mut watcher = match recommended_watcher(move |res| {
            let _ = tx.send(res);
        }) {
            Ok(w) => w,
            Err(e) => {
                let _ = app_handle.emit(
                    "flota-status",
                    StatusPayload {
                        status: "error",
                        detail: Some(format!("failed to create watcher: {e}")),
                    },
                );
                return;
            }
        };
        if let Err(e) = watcher.watch(&missions_dir, RecursiveMode::Recursive) {
            let _ = app_handle.emit(
                "flota-status",
                StatusPayload {
                    status: "error",
                    detail: Some(format!("watch({}) failed: {e}", missions_dir.display())),
                },
            );
            // Fall through anyway — the 300ms polling loop below still works
            // without live fs-notify wakeups (e.g. missions dir created later).
        }

        let mut current: Option<(String, PathBuf)> = None;
        let mut known_lines: usize = 0;

        loop {
            // Auto-follow: pick up the first mission that appears, and
            // switch (resetting the cursor) whenever a newer one shows up.
            if let Some((id, file)) = newest_mission(&missions_dir) {
                let is_new_mission = current.as_ref().map(|(cid, _)| cid != &id).unwrap_or(true);
                if is_new_mission {
                    // Read whatever's already on disk for the new mission up
                    // front and EMIT it as a fresh `flota-snapshot`, mirroring
                    // devBridge.mjs's switchTo() (which re-broadcasts a
                    // snapshot on mission switch). Without this, the webview
                    // only saw a bare status change and kept its OLD
                    // mission's seq ceiling, so the new mission's events
                    // (seqs restarting at 1) were silently dropped as
                    // "already covered by the snapshot" and any survivors
                    // got folded onto the old mission's state.
                    let initial_events = fs::read_to_string(&file)
                        .map(|text| parse_complete_lines(&text))
                        .unwrap_or_default();
                    known_lines = initial_events.len();
                    current = Some((id.clone(), file));
                    {
                        let mut st = shared.0.lock().unwrap();
                        st.mission_id = Some(id.clone());
                        st.events = initial_events.clone();
                    }
                    let _ = app_handle.emit(
                        "flota-snapshot",
                        SnapshotPayload {
                            mission_id: Some(id.clone()),
                            events: initial_events,
                        },
                    );
                    let _ = app_handle.emit(
                        "flota-status",
                        StatusPayload {
                            status: "open",
                            detail: Some(format!("following mission {id}")),
                        },
                    );
                }
            }

            if let Some((id, file)) = current.clone() {
                if let Ok(text) = fs::read_to_string(&file) {
                    let parsed = parse_complete_lines(&text);
                    if parsed.len() > known_lines {
                        let mut st = shared.0.lock().unwrap();
                        for event in &parsed[known_lines..] {
                            st.events.push(event.clone());
                            let _ = app_handle.emit(
                                "flota-event",
                                EventPayload {
                                    mission_id: id.clone(),
                                    event: event.clone(),
                                },
                            );
                        }
                        drop(st);
                        known_lines = parsed.len();
                    }
                }
            }

            // Wake on an fs event, or every 300ms regardless (catches a
            // brand-new mission dir appearing under a recursive watch, and
            // is the sole heartbeat if `watch()` above failed).
            let _ = rx.recv_timeout(Duration::from_millis(300));
        }
    });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(SharedMissionState::default())
        .invoke_handler(tauri::generate_handler![get_snapshot])
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            let shared = app.state::<SharedMissionState>().inner().clone();
            spawn_watcher(app.handle().clone(), shared);
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
