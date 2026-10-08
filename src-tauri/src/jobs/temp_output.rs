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

#[derive(Debug)]
pub struct TempOutputCommit {
    pub final_path: PathBuf,
    pub cleanup_warning: Option<String>,
}

#[derive(Debug)]
pub enum TempOutputError {
    DestinationExists,
    PublicationUnavailable { details: String },
    Io(io::Error),
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

    pub fn commit(self) -> Result<TempOutputCommit, TempOutputError> {
        self.commit_inner(
            None::<fn()>,
            |source, destination| fs::hard_link(source, destination),
            |path| remove_if_present(path),
        )
    }

    fn commit_inner<F, P, C>(
        mut self,
        before_publish: Option<F>,
        publish: P,
        cleanup: C,
    ) -> Result<TempOutputCommit, TempOutputError>
    where
        F: FnOnce(),
        P: FnOnce(&Path, &Path) -> io::Result<()>,
        C: FnOnce(&Path) -> io::Result<()>,
    {
        let file = match self.file.take() {
            Some(file) => file,
            None => OpenOptions::new()
                .read(true)
                .write(true)
                .open(&self.path)
                .map_err(TempOutputError::Io)?,
        };
        file.sync_all().map_err(TempOutputError::Io)?;
        drop(file);
        if let Some(before_publish) = before_publish {
            before_publish();
        }

        match publish(&self.path, &self.final_path) {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                return Err(TempOutputError::DestinationExists);
            }
            Err(_error) if destination_exists(&self.final_path).unwrap_or(false) => {
                return Err(TempOutputError::DestinationExists);
            }
            Err(error) => {
                return Err(TempOutputError::PublicationUnavailable {
                    details: error.to_string(),
                });
            }
        }
        let cleanup_warning = cleanup(&self.path).err().map(|error| error.to_string());
        Ok(TempOutputCommit {
            final_path: self.final_path.clone(),
            cleanup_warning,
        })
    }

    #[cfg(test)]
    fn commit_for_test(
        self,
        before_publish: impl FnOnce(),
        cleanup: impl FnOnce(&Path) -> io::Result<()>,
    ) -> Result<TempOutputCommit, TempOutputError> {
        self.commit_inner(
            Some(before_publish),
            |source, destination| fs::hard_link(source, destination),
            cleanup,
        )
    }

    #[cfg(test)]
    fn commit_with_publish_error_for_test(
        self,
        error: io::Error,
    ) -> Result<TempOutputCommit, TempOutputError> {
        self.commit_inner(
            None::<fn()>,
            move |_, _| Err(io::Error::new(error.kind(), error.to_string())),
            |path| remove_if_present(path),
        )
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

    use super::{TempOutput, TempOutputError};

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
            }, remove_temp)
            .expect_err("commit should not replace destination");

        assert!(matches!(error, TempOutputError::DestinationExists));
        assert_eq!(fs::read(final_path).expect("existing output should remain"), b"original");
        assert!(!temp_path.exists());
    }

    fn remove_temp(path: &std::path::Path) -> std::io::Result<()> {
        fs::remove_file(path)
    }

    #[test]
    fn reports_publication_cleanup_warning_after_successful_no_replace_link() {
        let directory = destination();
        let final_path = directory.join("cleanup-warning.flac");
        let temp = TempOutput::create(&final_path).expect("temp should be created");
        fs::write(temp.path(), b"published").expect("test output should be writable");

        let publication = temp
            .commit_for_test(|| {}, |_| {
                Err(std::io::Error::new(
                    std::io::ErrorKind::PermissionDenied,
                    "simulated temporary cleanup failure",
                ))
            })
            .expect("publication should succeed despite cleanup warning");

        assert_eq!(fs::read(&final_path).expect("published output should exist"), b"published");
        assert_eq!(
            publication.cleanup_warning.as_deref(),
            Some("simulated temporary cleanup failure")
        );
        drop(publication);
        let _ = fs::remove_file(&final_path);
    }

    #[test]
    fn reports_clear_capability_error_without_fallback_publication() {
        let directory = destination();
        let final_path = directory.join("unsupported-publication.flac");
        let temp = TempOutput::create(&final_path).expect("temp should be created");
        fs::write(temp.path(), b"not published").expect("test output should be writable");
        let temp_path = temp.path().to_owned();

        let error = temp
            .commit_with_publish_error_for_test(std::io::Error::new(
                std::io::ErrorKind::Unsupported,
                "hard links are unsupported",
            ))
            .expect_err("unsupported publication should fail");

        assert!(matches!(error, TempOutputError::PublicationUnavailable { details } if details.contains("hard links are unsupported")));
        assert!(!final_path.exists());
        assert!(!temp_path.exists());
    }
}
