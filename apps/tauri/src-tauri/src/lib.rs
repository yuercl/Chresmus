// Mobile entry point annotation — required for iOS/Android builds.
// On desktop this macro is a no-op.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .setup(|_app| Ok(()))
        .run(tauri::generate_context!())
        .expect("error while running Chresmus");
}
