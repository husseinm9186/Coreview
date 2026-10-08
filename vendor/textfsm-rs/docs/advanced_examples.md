# Advanced Template Examples

This guide walks through creating TextFSM templates for increasingly complex scenarios, from simple single-line output to nested tables.

## 1. Single Line Parsing

**Goal**: Parse the output of a `show clock` command into a single record.

**Input**:
```text
18:42:41.321 PST Sun Feb 8 2009
```

**Template (`cisco_clock.textfsm`)**:
```textfsm
# Define Values with regex groups
Value Year (\d+)
Value MonthDay (\d+)
Value Month (\w+)
Value Timezone (\S+)
Value Time (..:..:..)

# Mandatory Start state
Start
  # Match line, capture variables, and Record immediately.
  ^${Time}.* ${Timezone} \w+ ${Month} ${MonthDay} ${Year} -> Record
```

**Result**:
| Year | MonthDay | Month | Timezone | Time |
| :--- | :--- | :--- | :--- | :--- |
| 2009 | 8 | Feb | PST | 18:42:41 |

---

## 2. Multi-Line Record Parsing

**Goal**: Extract system information from `show version`, where data is spread across many lines.

**Input**:
```text
Cisco IOS Software, Catalyst 4500 L3 Switch Software... Version 12.2(31)SGA1...
...
router.abc uptime is 11 weeks, 4 days, 20 hours, 26 minutes
...
Configuration register is 0x2102
```

**Template (`cisco_version.textfsm`)**:
```textfsm
Value Version ([^ ,]+)
Value Uptime (.*)
Value ConfigRegister (\w+)

Start
  ^Cisco IOS .*Version ${Version},
  ^.*uptime is ${Uptime}
  # When we see the config register, record the accumulated data
  ^Configuration register is ${ConfigRegister} -> Record
```

**Result**:
| Version | Uptime | ConfigRegister |
| :--- | :--- | :--- |
| 12.2(31)SGA1 | 11 weeks, 4 days, 20 hours, 26 minutes | 0x2102 |

---

## 3. Tabular Data (Looping)

**Goal**: Parse a table of interface modules from `show chassis fpc`.

**Input**:
```text
Slot State            (C)  Total  Interrupt      DRAM (MB) Heap     Buffer
  0  Online            24      7          0       256        38         51
  1  Online            25      7          0       256        38         51
  4  Empty
```

**Template (`juniper_fpc.textfsm`)**:
```textfsm
Value Slot (\d)
Value State (\w+)
Value Temperature (\d+)
Value DRAM (\d+)

Start
  # Match Online modules
  ^\s+${Slot}\s+${State}\s+${Temperature}\s+\d+\s+\d+\s+${DRAM} -> Record
  # Match Empty modules (fewer fields)
  ^\s+${Slot}\s+${State} -> Record
```

---

## 4. Complex State Management (Filldown)

**Goal**: Parse nested data where a header (Chassis ID) applies to multiple following rows.

**Input**:
```text
lcc0-re0:
Slot State ...
  0  Online ...
  1  Online ...

lcc1-re1:
Slot State ...
  0  Online ...
```

**Template**:
```textfsm
# Filldown keeps the value for subsequent records until changed
Value Filldown Chassis (\S+)
Value Required Slot (\d)
Value State (\w+)

Start
  # Capture Chassis header
  ^${Chassis}:
  # Capture rows. Chassis value is auto-filled.
  ^\s+${Slot}\s+${State} -> Record
```

**Result**:
| Chassis | Slot | State |
| :--- | :--- | :--- |
| lcc0-re0 | 0 | Online |
| lcc0-re0 | 1 | Online |
| lcc1-re1 | 0 | Online |

---

## 5. Lists and Forward Lookahead

**Goal**: Parse a routing table where one destination has multiple gateways.

**Input**:
```text
B EX 0.0.0.0/0          via 192.0.2.73
                        via 192.0.2.201
B IN 192.0.2.76/30      via 203.0.113.183
```

**Template**:
```textfsm
Value Protocol (\S)
Value Type (\S\S)
Value Required Prefix (\S+)
# List allows multiple matches per record
Value List Gateway (\S+)

Start
  # If we see a new route line, Record the *previous* one first
  ^  \S \S\S -> Continue.Record
  # Capture the first line of a route
  ^  ${Protocol} ${Type} ${Prefix}\s+via ${Gateway}
  # Capture additional gateways for the *current* route
  ^\s+via ${Gateway}
```

**Explanation**:
1.  `Value List Gateway` allows the `Gateway` field to hold multiple IP addresses.
2.  `^ \S \S\S -> Continue.Record`: This is a "peek" ahead. When the parser sees a line starting a new route (like `B IN...`), it first `Record`s the data collected for the *previous* route. `Continue` means it then proceeds to match the *current* line against the next rules to start the *new* record.
3.  The final rule `^\s+via ${Gateway}` collects extra gateways into the list for the current record.
