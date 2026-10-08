use std::fs::{self, File, OpenOptions};
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

static NEXT_TEMP_ID: AtomicU64 = AtomicU64::new(1);

pub struct TempOutput {
    path: PathBuf,
    final_path: PathBuf,
    file: Option<File>,
}

impl TempOutput {
    pub fn create(final_path: impl AsRef<Path>) -> io::Result<Self> {
        let final_path = final_path.as_ref().to_owned();
        let directory = final_path.parent().unwrap_or_else(|| Path::new("."));
        fs::create_dir_all(directory)?;
        let stem = final_path
            .file_stem()
            .and_then(|value| value.to_str())
            .unwrap_or("output");
        let extension = final_path
            .extension()
            .and_then(|value| value.to_str())
            .map(|value| format!(".{value}"))
            .unwrap_or_default();

        for _ in 0..32 {
            let id = NEXT_TEMP_ID.fetch_add(1, Ordering::Relaxed);
            let name = format!(".{stem}.lumaflow-{id}-{}.tmp{extension}", std::process::id());
            let path = directory.join(name);
            match OpenOptions::new()
                .create_new(true)
                .read(true)
                .write(true)
                .open(&path)
            {
                Ok(file) => {
                    return Ok(Self {
                        path,
                        final_path,
                        file: Some(file),
                    });
                }
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
                Err(error) => return Err(error),
            }
        }

        Err(io::Error::new(
            io::ErrorKind::AlreadyExists,
            "could not allocate a unique temporary output path",
        ))
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn release(&mut self) {
        self.file.take();
    }

    pub fn commit(mut self) -> io::Result<PathBuf> {
        let file = match self.file.take() {
            Some(file) => file,
            None => OpenOptions::new().read(true).write(true).open(&self.path)?,
        };
        file.sync_all()?;
        drop(file);
        fs::rename(&self.path, &self.final_path)?;
        Ok(self.final_path.clone())
    }

    pub fn cleanup(mut self) -> io::Result<()> {
        self.file.take();
        remove_if_present(&self.path)
    }
}

impl Drop for TempOutput {
    fn drop(&mut self) {
        self.file.take();
        let _ = remove_if_present(&self.path);
    }
}

fn remove_if_present(path: &Path) -> io::Result<()> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error),
    }
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::PathBuf;

    use super::TempOutput;

    fn destination() -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "lumaflow-temp-output-test-{}",
            std::process::id()
        ));
        fs::create_dir_all(&path).expect("test destination should be creatable");
        path
    }

    #[test]
    fn creates_unique_destination_local_temp_with_final_extension() {
        let directory = destination();
        let final_path = directory.join("movie.flac");
        let first = TempOutput::create(&final_path).expect("first temp should be created");
        let second = TempOutput::create(&final_path).expect("second temp should be created");

        assert_ne!(first.path(), second.path());
        assert_ne!(first.path(), final_path.as_path());
        assert_eq!(first.path().extension().and_then(|value| value.to_str()), Some("flac"));
        assert!(first.path().starts_with(&directory));
        assert!(first.path().exists());
        assert!(second.path().exists());
        drop(first);
        drop(second);
        assert!(!final_path.exists());
    }

    #[test]
    fn commit_syncs_renames_and_removes_temp_path() {
        let directory = destination();
        let final_path = directory.join("committed.flac");
        let temp_path = {
            let temp = TempOutput::create(&final_path).expect("temp should be created");
            fs::write(temp.path(), b"finished output").expect("test output should be writable");
            let temp_path = temp.path().to_owned();
            temp.commit().expect("temp should commit");
            temp_path
        };

        assert!(!temp_path.exists());
        assert_eq!(fs::read(&final_path).expect("final output should exist"), b"finished output");
    }

    #[test]
    fn dropping_uncommitted_output_cleans_it_up() {
        let directory = destination();
        let final_path = directory.join("cancelled.flac");
        let temp_path = {
            let temp = TempOutput::create(&final_path).expect("temp should be created");
            let temp_path = temp.path().to_owned();
            assert!(temp.cleanup().is_ok());
            temp_path
        };

        assert!(!temp_path.exists());
        assert!(!final_path.exists());
    }
}
