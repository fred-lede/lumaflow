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
        if destination_exists(&final_path)? {
            return Err(destination_exists_error());
        }
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

    pub fn commit(self) -> io::Result<PathBuf> {
        self.commit_inner(None::<fn()>)
    }

    fn commit_inner<F: FnOnce()>(mut self, before_publish: Option<F>) -> io::Result<PathBuf> {
        let file = match self.file.take() {
            Some(file) => file,
            None => OpenOptions::new().read(true).write(true).open(&self.path)?,
        };
        file.sync_all()?;
        drop(file);
        if let Some(before_publish) = before_publish {
            before_publish();
        }

        match fs::hard_link(&self.path, &self.final_path) {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                return Err(destination_exists_error());
            }
            Err(error) => return Err(error),
        }
        remove_if_present(&self.path)?;
        Ok(self.final_path.clone())
    }

    #[cfg(test)]
    fn commit_for_test(self, before_publish: impl FnOnce()) -> io::Result<PathBuf> {
        self.commit_inner(Some(before_publish))
    }

    pub fn cleanup(mut self) -> io::Result<()> {
        self.file.take();
        remove_if_present(&self.path)
    }
}

fn destination_exists_error() -> io::Error {
    io::Error::new(
        io::ErrorKind::AlreadyExists,
        "the final output destination already exists",
    )
}

fn destination_exists(path: &Path) -> io::Result<bool> {
    match fs::symlink_metadata(path) {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error),
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
    fn commit_syncs_publishes_and_removes_temp_path() {
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

    #[test]
    fn refuses_to_create_when_final_destination_already_exists() {
        let directory = destination();
        let final_path = directory.join("already-exists.flac");
        fs::write(&final_path, b"original").expect("existing output should be writable");

        let error = match TempOutput::create(&final_path) {
            Ok(_) => panic!("existing output should reject creation"),
            Err(error) => error,
        };

        assert_eq!(error.kind(), std::io::ErrorKind::AlreadyExists);
        assert_eq!(fs::read(final_path).expect("existing output should remain"), b"original");
    }

    #[test]
    fn refuses_to_commit_over_a_destination_created_after_temp_allocation() {
        let directory = destination();
        let final_path = directory.join("destination-race.flac");
        let temp = TempOutput::create(&final_path).expect("temp should be created");
        let temp_path = temp.path().to_owned();

        let error = temp
            .commit_for_test(|| {
                fs::write(&final_path, b"original").expect("destination should be created");
            })
            .expect_err("commit should not replace destination");

        assert_eq!(error.kind(), std::io::ErrorKind::AlreadyExists);
        assert_eq!(fs::read(final_path).expect("existing output should remain"), b"original");
        assert!(!temp_path.exists());
    }
}
