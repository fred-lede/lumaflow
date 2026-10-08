pub mod ffmpeg_args;
pub mod planner;
pub mod probe;
pub mod tools;

use std::path::Path;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MediaError {
    pub code: String,
    pub message: String,
    pub details: Option<String>,
}

#[cfg(test)]
mod tools_contract_tests {
    use super::tools::{target_directory, ToolLocator};
    use std::path::Path;

    #[test]
    fn bundled_locator_uses_the_platform_specific_resource_directory() {
        let locator = ToolLocator::bundled();
        locator.set_resource_dir(Path::new("/resources"));

        assert_eq!(
            locator.resolve("ffmpeg").expect("bundled path should resolve"),
            Path::new("/resources")
                .join("binaries")
                .join(target_directory())
                .join("ffmpeg")
        );
    }

    #[test]
    fn bundled_locator_rejects_unconfigured_resources_instead_of_using_path() {
        let error = ToolLocator::bundled()
            .resolve("ffprobe")
            .expect_err("bundled locator must not fall back to PATH");

        assert_eq!(error.code(), "bundled_tool_unconfigured");
    }
}

impl MediaError {
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            details: None,
        }
    }

    pub fn with_details(
        code: impl Into<String>,
        message: impl Into<String>,
        details: impl Into<String>,
    ) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            details: Some(details.into()),
        }
    }
}

impl std::fmt::Display for MediaError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for MediaError {}

pub(crate) fn resolve_container_name(
    container: &str,
    source_path: &str,
) -> Result<String, MediaError> {
    let names = container
        .split(',')
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .map(str::to_ascii_lowercase)
        .collect::<Vec<_>>();

    if names.is_empty() {
        return Err(MediaError::new(
            "unknown_container",
            "The source container is empty or unknown",
        ));
    }

    if names.len() == 1 {
        return Ok(names[0].clone());
    }

    if names == ["mov", "mp4", "m4a", "3gp", "3g2", "mj2"] {
        let extension = Path::new(source_path)
            .extension()
            .and_then(|value| value.to_str())
            .map(str::to_ascii_lowercase);

        return match extension.as_deref() {
            Some("mp4") | Some("mov") | Some("m4a") => Ok(extension.unwrap()),
            _ => Err(MediaError::with_details(
                "unknown_container",
                "The composite source container cannot be disambiguated safely",
                container,
            )),
        };
    }

    if names == ["matroska", "webm"] {
        let extension = Path::new(source_path)
            .extension()
            .and_then(|value| value.to_str())
            .map(str::to_ascii_lowercase);

        return match extension.as_deref() {
            Some("mkv") => Ok("matroska".to_owned()),
            Some("webm") => Ok("webm".to_owned()),
            _ => Err(MediaError::with_details(
                "unknown_container",
                "The composite Matroska/WebM container cannot be disambiguated safely",
                container,
            )),
        };
    }

    Err(MediaError::with_details(
        "unknown_container",
        "The composite source container is not supported safely",
        container,
    ))
}
