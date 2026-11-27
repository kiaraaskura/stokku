// Stokku desktop shell. The entire app is the built web bundle (../../web/dist)
// running fully client-side: SQLite in the webview's local storage, no server
// required. See docs/PLATFORMS.md for the packaging matrix.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("error while running Stokku desktop");
}
