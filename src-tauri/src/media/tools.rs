use std::path::{Path, PathBuf};
use std::sync::{Arc, RwLock};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ToolResolutionError {
    code: &'static str,
    message: String,
}

impl ToolResolutionError {
    pub fn code(&self) -> &'static str {
        self.code
    }
}

impl std::fmt::Display for ToolResolutionError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for ToolResolutionError {}

#[derive(Clone)]
pub struct ToolLocator {
    resource_dir: Arc<RwLock<Option<PathBuf>>>,
    allow_system_path: bool,
}

impl ToolLocator {
    pub fn system() -> Self {
        Self {
            resource_dir: Arc::new(RwLock::new(None)),
            allow_system_path: true,
        }
    }

    pub fn bundled() -> Self {
        Self {
            resource_dir: Arc::new(RwLock::new(None)),
            allow_system_path: false,
        }
    }

    pub fn set_resource_dir(&self, resource_dir: &Path) {
        *self
            .resource_dir
            .write()
            .expect("tool resource lock should not be poisoned") = Some(resource_dir.to_owned());
    }

    pub fn resolve(&self, tool: &str) -> Result<PathBuf, ToolResolutionError> {
        let executable = executable_name(tool)?;
        if let Some(resource_dir) = self
            .resource_dir
            .read()
            .expect("tool resource lock should not be poisoned")
            .as_ref()
        {
            return Ok(resource_dir
                .join("binaries")
                .join(target_directory())
                .join(executable));
        }

        if self.allow_system_path {
            return Ok(PathBuf::from(executable));
        }

        Err(ToolResolutionError {
            code: "bundled_tool_unconfigured",
            message: format!(
                "The bundled {tool} resource directory has not been configured"
            ),
        })
    }
}

fn executable_name(tool: &str) -> Result<&'static str, ToolResolutionError> {
    match tool {
        "ffmpeg" => {
            #[cfg(target_os = "windows")]
            return Ok("ffmpeg.exe");
            #[cfg(not(target_os = "windows"))]
            return Ok("ffmpeg");
        }
        "ffprobe" => {
            #[cfg(target_os = "windows")]
            return Ok("ffprobe.exe");
            #[cfg(not(target_os = "windows"))]
            return Ok("ffprobe");
        }
        _ => Err(ToolResolutionError {
            code: "unsupported_media_tool",
            message: format!("Unsupported media tool: {tool}"),
        }),
    }
}

#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
pub fn target_directory() -> &'static str {
    "darwin-arm64"
}

#[cfg(all(target_os = "macos", target_arch = "x86_64"))]
pub fn target_directory() -> &'static str {
    "darwin-x64"
}

#[cfg(all(target_os = "windows", target_arch = "x86_64"))]
pub fn target_directory() -> &'static str {
    "windows-x64"
}

#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
pub fn target_directory() -> &'static str {
    "linux-x64"
}

#[cfg(not(any(
    all(target_os = "macos", target_arch = "aarch64"),
    all(target_os = "macos", target_arch = "x86_64"),
    all(target_os = "windows", target_arch = "x86_64"),
    all(target_os = "linux", target_arch = "x86_64"),
)))]
pub fn target_directory() -> &'static str {
    "unsupported"
}
