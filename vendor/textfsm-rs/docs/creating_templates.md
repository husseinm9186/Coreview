# Creating TextFSM Templates

TextFSM templates are the core of the parsing engine. They define how raw text is processed and extracted into structured data. A template consists of **Value Definitions** and **State Definitions**.

## 1. Value Definitions

These lines appear at the top of the file and define the fields you want to extract.

**Syntax:**
```textfsm
Value [Option[,Option...]] Name (Regex)
```

-   **Name**: The variable name (e.g., `Version`, `Interface`).
-   **Regex**: A Regular Expression (PCRE/Rust-style) to capture the value. It must be enclosed in parentheses if you want to capture specific parts, though TextFSM often treats the whole regex as the capture group if not specified.
-   **Options** (Optional): Comma-separated flags affecting behavior.

> **Note:** When naming your values, please refer to the [Common Capture Groups](common_capture_groups.md) reference to ensure consistency with standard conventions.

### Supported Options

| Option | Description |
| :--- | :--- |
| `Key` | Marks this value as part of the unique identifier (primary key) for the record. |
| `Required` | The record will only be saved if this value has been matched. |
| `Filldown` | The previously matched value is retained for subsequent records (unless explicitly cleared or matched again). |
| `Fillup` | The value is copied *upwards* to previous records in the current block (less common). Not compatible with `Required` or `List`. |
| `List` | Allows multiple matches for this value within a single record. Appended on each match. |

**Examples:**
```textfsm
Value Required Hostname (\S+)
Value List IpAddress ([0-9.]+)
Value Filldown Interface (\S+)
```

## 2. State Definitions

After values are defined, the template must define at least one state: `Start`. Each state definition is separated by a blank line.

**Syntax:**
```textfsm
StateName
 ^RuleRegex [-> Action]
 ^RuleRegex [-> Action]
```

-   **StateName**: A label for a block of rules. The parser starts in the `Start` state.
-   **RuleRegex**: A regex to match the current line. It can contain variables like `${Name}`.
-   **Action** (Optional): What to do when the line matches.

### Rules

Rules are processed in order. If a line matches a rule, the Action is executed. If no action is specified, `Next.NoRecord` is implied (move to next line).

**Syntax:** `^Regex [-> Action]`

-   The regex must start with `^` to match the start of the line (TextFSM convention, enforced as a reminder).
-   Use `${ValueName}` (preferred) or `$ValueName` in the regex to capture data into a defined Value.
-   Use `$$` to match a literal `$` (end of line matching usually handled by regex anchor `$`).

### Actions

Actions control the flow of the state machine and record generation. They are delimited by `->`.

**Format:** `A.B C` or `Action` or `Action.NextState`

Where:
-   **A**: Line Action
-   **B**: Record Action
-   **C**: New State

| Line Action (A) | Description |
| :--- | :--- |
| `Next` | (Default) Finish with the current input line, read the next line, and start matching from the top of the current state. |
| `Continue` | Retain the current line. Continue matching subsequent rules in the current state. Value assignments still occur. |

| Record Action (B) | Description |
| :--- | :--- |
| `NoRecord` | (Default) Do nothing. |
| `Record` | Save the current values as a `DataRecord`. Non-Filldown values are cleared. **Note:** No record is output if any `Required` values are unassigned. |
| `Clear` | Clear non-Filldown values. |
| `Clearall` | Clear *all* values (including Filldown). |

| New State (C) | Description |
| :--- | :--- |
| `StateName` | Transition to a new state definition (e.g., `Start`, `ParseInterface`). Next line is read (unless `Continue` was used, though `Continue` with state transition is not allowed to prevent loops). |
| `Error ["msg"]` | Terminate processing immediately. Discard all records. Raise an exception with optional message. |

**Implicit Defaults:**
-   If no action is specified: `Next.NoRecord`
-   `Next` implies `Next.NoRecord`
-   `Record` implies `Next.Record`

**Examples:**
```textfsm
  # Capture uptime and move to next line (default action)
  ^Uptime is ${Uptime}

  # Capture Interface and transition to ParseInterface state
  ^Interface ${Interface} -> ParseInterface

  # Record the current data and continue parsing the SAME line
  # (Useful if one line contains multiple records or data points)
  ^  IP Address: ${IpAddress} -> Record Continue

  # Error if we see something unexpected
  ^% Invalid input -> Error "Unexpected Input"
```

## 3. Special States

-   **`Start`**: Mandatory. The parser begins here.
-   **`EOF`**: Optional. Implicitly called when input ends. Default behavior is `^.* -> Record` (save the last record). Define an empty `EOF` state to suppress this.
-   **`End`**: Reserved state. Terminates processing immediately (does not execute `EOF` state rules).

## 4. Complete Example

**Input (`sh version`):**
```text
Cisco IOS Software, C3750 Software (C3750-IPSERVICESK9-M), Version 12.2(46)SE, RELEASE SOFTWARE (fc2)
Copyright (c) 1986-2008 by Cisco Systems, Inc.
cisco WS-C3750G-24TS (PowerPC405) processor (revision R0) with 131072K bytes of memory.
Model number: WS-C3750G-24TS-1U
System serial number: FDO12345678
```

**Template:**
```textfsm
# Define Values
Value Version (\S+)
Value Model (\S+)
Value Serial (\S+)

# Start State
Start
  ^Cisco IOS Software.*Version ${Version}, -> Continue
  ^Model number: ${Model}
  ^System serial number: ${Serial} -> Record
```

**Explanation:**
1.  `Value` definitions create slots for Version, Model, and Serial.
2.  `Start` state begins processing lines.
3.  Line 1 matches `Cisco IOS...`. It extracts `12.2(46)SE` into `Version`. `-> Continue` means it keeps looking for other rules on *this same line* (though none match here).
4.  Line 4 matches `Model number`. Extracts `WS-C3750G-24TS-1U`.
5.  Line 5 matches `System serial`. Extracts `FDO12345678`. `-> Record` saves the row {Version, Model, Serial} and resets variables.

## 5. Tips & Best Practices

1.  **Anchor Regexes**: Always start rules with `^` to avoid accidental mid-line matches.
2.  **Order Matters**: Put specific rules before general ones. The first match wins unless `Continue` is used.
3.  **Whitespace**: Use `\s+` or explicit spaces in regex to match whitespace in the input.
4.  **Testing**: Use the `textfsm-rs` tests or standard regex tools (like Regex101, selecting Python flavor) to verify your regex patterns.
5.  **Variables**: Use `${Var}` for simple matching.