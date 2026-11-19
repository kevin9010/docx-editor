use std::{
    fs::{self, OpenOptions},
    io::{self, Write},
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

use serde::Serialize;
use tauri::ipc::{InvokeBody, Request, Response};

const MAX_DOCUMENT_BYTES: u64 = 100 * 1024 * 1024;

/// Header carrying the percent-encoded destination path of a raw `write_file`
/// payload. Header values must be ASCII, and Windows paths often are not.
const DOCUMENT_PATH_HEADER: &str = "x-superdoc-path";

#[cfg(windows)]
#[link(name = "kernel32")]
extern "system" {
    fn MoveFileExW(existing_file_name: *const u16, new_file_name: *const u16, flags: u32) -> i32;
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentFileMetadata {
    modified_at_ms: u128,
    size: u64,
}

fn validate_path(raw_path: &str) -> Result<PathBuf, String> {
    let trimmed = raw_path.trim();
    if trimmed.is_empty() {
        return Err("A document path is required.".to_string());
    }

    let path = PathBuf::from(trimmed);
    if !path.is_absolute() {
        return Err("Document paths must be absolute.".to_string());
    }

    if path
        .extension()
        .and_then(|extension| extension.to_str())
        .map(|extension| extension.eq_ignore_ascii_case("docx"))
        != Some(true)
    {
        return Err("Only .docx files are supported.".to_string());
    }

    Ok(path)
}

fn check_document_size(size: u64) -> Result<(), String> {
    if size > MAX_DOCUMENT_BYTES {
        return Err(format!(
            "The document is too large. The maximum supported size is {} MB.",
            MAX_DOCUMENT_BYTES / (1024 * 1024)
        ));
    }
    Ok(())
}

fn decode_path_header(value: &str) -> Result<String, String> {
    let invalid = || "The document path header is not valid percent-encoding.".to_string();
    let bytes = value.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            let hex = bytes.get(index + 1..index + 3).ok_or_else(invalid)?;
            if !hex.iter().all(u8::is_ascii_hexdigit) {
                return Err(invalid());
            }
            let text = std::str::from_utf8(hex).map_err(|_| invalid())?;
            decoded.push(u8::from_str_radix(text, 16).map_err(|_| invalid())?);
            index += 3;
        } else {
            decoded.push(bytes[index]);
            index += 1;
        }
    }
    String::from_utf8(decoded).map_err(|_| "The document path is not valid UTF-8.".to_string())
}

/// Read a document and hand its bytes to the webview as a binary IPC response.
/// Returning `Vec<u8>` would serialize every byte as a JSON number.
#[tauri::command]
pub async fn read_file(path: String) -> Result<Response, String> {
    let path = validate_path(&path)?;
    tauri::async_runtime::spawn_blocking(move || {
        let metadata = fs::metadata(&path)
            .map_err(|error| format!("Could not inspect the document: {error}"))?;
        check_document_size(metadata.len())?;
        let data =
            fs::read(&path).map_err(|error| format!("Could not read the document: {error}"))?;
        check_document_size(data.len() as u64)?;
        Ok(Response::new(data))
    })
    .await
    .map_err(|error| error.to_string())?
}

/// Write a document sent as a raw `application/octet-stream` IPC body. The
/// destination travels in [`DOCUMENT_PATH_HEADER`].
#[tauri::command]
pub async fn write_file(request: Request<'_>) -> Result<(), String> {
    let encoded_path = request
        .headers()
        .get(DOCUMENT_PATH_HEADER)
        .ok_or_else(|| "A document path is required.".to_string())?
        .to_str()
        .map_err(|_| "The document path header is invalid.".to_string())?;
    let path = validate_path(&decode_path_header(encoded_path)?)?;
    let InvokeBody::Raw(data) = request.body() else {
        return Err("The document must be sent as binary data.".to_string());
    };
    check_document_size(data.len() as u64)?;
    let data = data.clone();
    tauri::async_runtime::spawn_blocking(move || atomic_write(&path, &data))
        .await
        .map_err(|error| error.to_string())?
}

#[cfg(not(windows))]
fn replace_file(source: &Path, destination: &Path) -> io::Result<()> {
    fs::rename(source, destination)
}

#[cfg(windows)]
fn replace_file(source: &Path, destination: &Path) -> io::Result<()> {
    use std::os::windows::ffi::OsStrExt;

    const MOVEFILE_REPLACE_EXISTING: u32 = 0x1;
    const MOVEFILE_WRITE_THROUGH: u32 = 0x8;
    let source_wide: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
    let destination_wide: Vec<u16> = destination
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect();
    let moved = unsafe {
        MoveFileExW(
            source_wide.as_ptr(),
            destination_wide.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if moved == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

fn atomic_write(path: &Path, data: &[u8]) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "The document path has no parent directory.".to_string())?;
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "The document path has an invalid file name.".to_string())?;
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| format!("Could not create a temporary file name: {error}"))?
        .as_nanos();
    let temporary_path = parent.join(format!(".{file_name}.{timestamp}.superdoc-tmp"));

    let write_result = (|| -> Result<(), String> {
        let mut temporary = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary_path)
            .map_err(|error| format!("Could not create a temporary document: {error}"))?;
        temporary
            .write_all(data)
            .map_err(|error| format!("Could not write the document: {error}"))?;
        temporary
            .sync_all()
            .map_err(|error| format!("Could not flush the document: {error}"))?;
        drop(temporary);

        replace_file(&temporary_path, path)
            .map_err(|error| format!("Could not replace the document: {error}"))
    })();

    if temporary_path.exists() {
        let _ = fs::remove_file(&temporary_path);
    }
    write_result
}

#[tauri::command]
pub async fn file_metadata(path: String) -> Result<DocumentFileMetadata, String> {
    let path = validate_path(&path)?;
    tauri::async_runtime::spawn_blocking(move || {
        let metadata = fs::metadata(&path)
            .map_err(|error| format!("Could not inspect the document: {error}"))?;
        check_document_size(metadata.len())?;
        let modified = metadata
            .modified()
            .map_err(|error| format!("Could not read the document timestamp: {error}"))?
            .duration_since(UNIX_EPOCH)
            .map_err(|error| format!("The document timestamp is invalid: {error}"))?;

        Ok(DocumentFileMetadata {
            modified_at_ms: modified.as_millis(),
            size: metadata.len(),
        })
    })
    .await
    .map_err(|error| error.to_string())?
}

#[cfg(test)]
mod tests {
    use super::decode_path_header;

    #[test]
    fn decodes_non_ascii_document_paths() {
        assert_eq!(
            decode_path_header("C%3A%5C%E6%96%87%E6%A1%A3%5Cdraft%20v2.docx").unwrap(),
            "C:\\文档\\draft v2.docx"
        );
        assert!(decode_path_header("C%3").is_err());
        assert!(decode_path_header("C%+1").is_err());
        assert!(decode_path_header("%FF").is_err());
    }
}
