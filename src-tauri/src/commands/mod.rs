pub mod files;
pub mod queue;

use serde::Serialize;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct CommandError {
    pub code: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<String>,
}

impl CommandError {
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

impl From<crate::media::MediaError> for CommandError {
    fn from(error: crate::media::MediaError) -> Self {
        Self {
            code: error.code,
            message: error.message,
            details: error.details,
        }
    }
}
