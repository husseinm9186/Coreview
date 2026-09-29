# Architecture & Implementation

## Core Components

### `TextFSM`
The main engine struct. It holds:
- **Parser**: The compiled Pest parser state (`TextFSMParser`).
- **State**: Current state name (e.g., "Start").
- **Records**: Accumulator for parsed data.

### `DataRecord`
Represents a single row of extracted data.
- **Fields**: A `HashMap<String, Value>` where keys are column names.
- **Record Key**: Optional unique identifier for the row.

### `Value`
An enum handling the dynamic typing of TextFSM values:
- `Value::Single(String)`: Standard scalar values.
- `Value::List(Vec<String>)`: List values (from `List` option).

## Parsing Logic

The parsing process is line-based:
1.  **State Lookup**: The engine checks the current state (defaulting to "Start").
2.  **Rule Matching**: It iterates through defined rules for that state.
3.  **Regex Matching**:
    -   Uses `regex` (standard) or `fancy-regex` (for lookarounds).
    -   Optimization: `insert_value_optimized` performs single-pass lookups for value definitions to reduce overhead.
4.  **Action Execution**:
    -   **Line Actions**: `Next`, `Continue`.
    -   **Record Actions**: `Record`, `NoRecord`, `Clear`, `Clearall`.

## Optimizations

### 1. Zero-Copy State Transitions
State names are managed as reused strings to avoid repeated allocation during transitions.

### 2. Efficient HashMap Operations
`DataRecord` uses the `Entry` API for insertions and updates, minimizing double-lookups.

### 3. Regex Anchoring
`CliTable` command matching anchors regexes (`^...$`) to prevent partial matches (e.g., `[[show]]` matching "show config").

## Project Structure

-   **`src/lib.rs`**: Core library logic (`TextFSM`, `DataRecord`).
-   **`src/cli_table.rs`**: Implementation of `CliTable` for template index parsing.
-   **`src/varsubst.rs`**: Variable substitution parser (`${VAR}`).
-   **`src/bin/textfsm.rs`**: The CLI entry point. Uses `clap` for argument parsing and `anyhow` for error handling.
-   **`src/textfsm.pest`**: PEG grammar for TextFSM templates.

## Dependencies

-   **`pest`**: PEG parser for the TextFSM template syntax.
-   **`fancy-regex`**: Support for Python-style regex features (lookahead/behind) required by many TextFSM templates.
-   **Serialization**:
    -   `serde`: The core serialization framework.
    -   `serde_yaml`: YAML serialization/deserialization.
    -   `serde_json`: JSON serialization/deserialization.
    -   Custom implementations in `src/export.rs` for CSV, Text, HTML, and XML formats.
-   **`thiserror`**: Ergonomic error handling for the library.
-   **`clap`**: Command-line argument parser for the binary.