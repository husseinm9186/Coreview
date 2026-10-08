# Usage Guide

`textfsm-rs` can be used both as a Rust library in your projects and as a standalone command-line tool.

## Library Usage

### Installation

Add `textfsm-rs` to your `Cargo.toml`:

```toml
[dependencies]
textfsm-rs = { git = "https://github.com/itsvrushabh/textfsm-rs.git" }
serde_yaml = "0.9" # Recommended for YAML serialization
```

### Feature Flags

To reduce dependencies, you can disable default features and pick only what you need.

```toml
[dependencies]
textfsm-rs = { git = "...", default-features = false, features = ["clitable", "yaml"] }
```

Available features:
-   `clitable`: Enables `CliTable` functionality (depends on `csv`).
-   `yaml`: Enables YAML export support (depends on `serde_yaml`).
-   `json`: Enables JSON export support (depends on `serde_json`).
-   `csv_export`: Enables CSV export support (depends on `csv`).
-   `binary`: Enables dependencies required for the CLI binary (`clap`, `anyhow`, etc.).

### Basic Parsing

To parse a raw text file using a TextFSM template:

```rust
use textfsm_rs::{TextFSM, DataRecordConversion};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    // 1. Load the template
    let mut fsm = TextFSM::from_file("path/to/template.textfsm")?;

    // 2. Parse the input content
    // Optional: Use DataRecordConversion::LowercaseKeys to normalize field names
    let results = fsm.parse_file("path/to/data.raw", Some(DataRecordConversion::LowercaseKeys))?;

    // 3. Process results
    for record in results {
        println!("{:?}", record.fields);
    }
    Ok(())
}
```

### Using CLI Table

The `CliTable` functionality allows automatic template selection based on the platform and command.

```rust
use textfsm_rs::CliTable;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    // Load the index file (usually 'index' in ntc-templates)
    let cli_table = CliTable::from_file("ntc_templates/templates/index")?;

    // Find a template
    if let Some((template_dir, row)) = cli_table.get_template_for_command("cisco_ios", "show version") {
        println!("Found template in: {}", template_dir);
        println!("Template files: {:?}", row.templates);
    }
    Ok(())
}
```

### Error Handling

The library uses a custom `TextFsmError` type (via `thiserror`). All major operations return a `Result`.

```rust
use textfsm_rs::TextFSM;

let fsm = match TextFSM::from_file("invalid.template") {
    Ok(f) => f,
    Err(e) => {
        eprintln!("Error loading template: {}", e);
        return;
    }
};
```

---

## Command Line Interface (CLI)

The `textfsm` binary allows you to parse files directly from the terminal.

### Installation

To install the binary globally:

```bash
cargo install --path . # If inside the repository
# OR
cargo install textfsm-rs # If published to crates.io (future)
```

### Commands

#### 1. `parse`: Direct Template Parsing

Parse a raw text file using a specific TextFSM template.

**Usage:**
```bash
textfsm parse --template <TEMPLATE_PATH> --input <DATA_PATH> [--lowercase] [--format <json|yaml|csv|text|html|xml>]
```

**Example:**
```bash
textfsm parse \
  --template templates/cisco_ios_show_version.textfsm \
  --input data/show_version.txt \
  --format json
```

### Output Examples

**JSON Output:**
```json
[
  {
    "version": "16.9.4",
    "uptime": "1 week, 2 days, 3 hours, 4 minutes",
    "hostname": "Router01"
  }
]
```

**YAML Output:**
```yaml
- version: 16.9.4
  uptime: 1 week, 2 days, 3 hours, 4 minutes
  hostname: Router01
```

**CSV Output:**
```csv
hostname,uptime,version
Router01,"1 week, 2 days, 3 hours, 4 minutes",16.9.4
```

**Text (ASCII Table) Output:**
```text
+----------+------------------------------------+---------+
| hostname | uptime                             | version |
+----------+------------------------------------+---------+
| Router01 | 1 week, 2 days, 3 hours, 4 minutes | 16.9.4  |
+----------+------------------------------------+---------+
```

**HTML Output:**
```html
<table class="table table-striped">
  <thead>
    <tr>
      <th>hostname</th>
      <th>uptime</th>
      <th>version</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td>Router01</td>
      <td>1 week, 2 days, 3 hours, 4 minutes</td>
      <td>16.9.4</td>
    </tr>
  </tbody>
</table>
```

**XML Output:**
```xml
<?xml version="1.0" encoding="UTF-8"?>
<root>
  <record>
    <hostname>Router01</hostname>
    <uptime>1 week, 2 days, 3 hours, 4 minutes</uptime>
    <version>16.9.4</version>
  </record>
</root>
```

#### 2. `auto`: Automatic Template Selection

Automatically find the correct template using an `ntc-templates` index file.

**Usage:**
```bash
textfsm auto \
  --index <INDEX_PATH> \
  --platform <PLATFORM> \
  --command <COMMAND> \
  --input <DATA_PATH> \
  [--format <json|yaml|csv|text|html|xml>]
```

**Example:**
```bash
textfsm auto \
  --index ntc_templates/templates/index \
  --platform cisco_ios \
  --command "show version" \
  --input data/show_version.txt
```

### Options

*   `--format`: Choose the output format.
    *   `yaml` (default): Human-readable YAML.
    *   `json`: JSON output, useful for piping to `jq`.
    *   `csv`: Comma-Separated Values (headers sorted alphabetically).
    *   `text`: ASCII table format (similar to MySQL output).
    *   `html`: HTML table with Bootstrap styling.
    *   `xml`: XML output.
*   `--lowercase` (parse only): Convert all keys in the output to lowercase.