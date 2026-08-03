use std::fs;
use tauri::{AppHandle, Manager};

const CONTACTS_FILE: &str = "contacts.json";

fn contacts_path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("could not resolve app data dir: {e}"))?;
    fs::create_dir_all(&dir).map_err(|e| format!("could not create app data dir: {e}"))?;
    Ok(dir.join(CONTACTS_FILE))
}

#[tauri::command]
fn load_contacts(app: AppHandle) -> Result<String, String> {
    let path = contacts_path(&app)?;
    if !path.exists() {
        return Ok("[]".to_string());
    }
    fs::read_to_string(&path).map_err(|e| format!("could not read contacts file: {e}"))
}

#[tauri::command]
fn save_contacts(app: AppHandle, json: String) -> Result<(), String> {
    let path = contacts_path(&app)?;
    fs::write(&path, json).map_err(|e| format!("could not write contacts file: {e}"))
}

#[tauri::command]
fn data_dir(app: AppHandle) -> Result<String, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("could not resolve app data dir: {e}"))?;
    fs::create_dir_all(&dir).map_err(|e| format!("could not create app data dir: {e}"))?;
    Ok(dir.to_string_lossy().to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            load_contacts,
            save_contacts,
            data_dir
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
