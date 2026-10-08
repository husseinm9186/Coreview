use std::io;
use thiserror::Error;

/// Custom error type for TextFSM operations.
#[derive(Debug, Error)]
pub enum TextFsmError {
    /// Errors related to file I/O.
    #[error("I/O error: {0}")]
    IoError(#[from] io::Error),
    /// Errors related to CSV parsing.
    #[cfg(any(feature = "clitable", feature = "csv_export"))]
    #[error("CSV error: {0}")]
    CsvError(#[from] csv::Error),
    /// Errors occurring during the parsing of templates or variable strings.
    #[error("Parse error: {0}")]
    ParseError(String),
    /// Errors related to invalid states or state transitions.
    #[error("State error: {0}")]
    StateError(String),
    /// Unrecoverable internal library errors.
    #[error("Internal error: {0}")]
    InternalError(String),
}

/// A specialized Result type for TextFSM operations.
pub type Result<T> = std::result::Result<T, TextFsmError>;
