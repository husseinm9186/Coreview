"""
Parsers: `textfsm:<name>` runs the vendored template of that name from the
directory Rust named in `hello` (resources/templates/ntc); `json` and
`xml` pass the platform's own structured answer through as one row;
`raw` and `none` return no rows. Keys are lower-cased the way
ntc-templates' own tests compare them.

Where ntc's index names several templates for one command
(`a.textfsm:b.textfsm`, the catalog's `also:`), the further templates
extend the first one's rows column-wise — joined on the first template's
`Key` values when it declares any, by row position otherwise — exactly as
textfsm's clitable does, so the vendored fixtures compare equal.
"""
from __future__ import annotations

import io
import json
import os
from functools import lru_cache
from typing import Optional

import textfsm

_templates_dir: Optional[str] = None


def set_templates_dir(path: str) -> None:
    global _templates_dir
    if not os.path.isdir(path):
        raise FileNotFoundError(path)
    _templates_dir = path
    _template.cache_clear()


def templates_dir() -> Optional[str]:
    return _templates_dir


@lru_cache(maxsize=256)
def _template(name: str) -> str:
    if _templates_dir is None:
        raise RuntimeError("no templates_dir; send hello first")
    if "/" in name or "\\" in name or ".." in name:
        raise ValueError(f"template name {name!r} is not a bare name")
    path = os.path.join(_templates_dir, f"{name}.textfsm")
    with open(path, encoding="utf-8") as f:
        return f.read()


class ParseError(Exception):
    pass


def _textfsm(name: str, raw: str) -> tuple[list[str], list[str], list[dict]]:
    """(header, key columns, rows) for one template, keys lower-cased."""
    try:
        text = _template(name)
    except FileNotFoundError:
        raise ParseError(f"textfsm: no template {name}") from None
    try:
        fsm = textfsm.TextFSM(io.StringIO(text))
        records = fsm.ParseText(raw)
    except textfsm.TextFSMTemplateError as e:
        raise ParseError(f"textfsm: {name}: template error: {e}") from None
    except textfsm.TextFSMError as e:
        raise ParseError(f"textfsm: {name}: {e}") from None
    header = [h.lower() for h in fsm.header]
    keys = [k.lower() for k in fsm.GetValuesByAttrib("Key")]
    # ntc's parse_output goes through clitable, whose table stores every cell as
    # text: a List value's missing captures come back as the string "None".
    rows = [dict(zip(header, [[("None" if v is None else v) for v in cell] if isinstance(cell, list) else cell for cell in record])) for record in records]
    return header, keys, rows


def _extend(header: list[str], rows: list[dict], keys: list[str], other_header: list[str], other_rows: list[dict]) -> None:
    """clitable's TextTable.extend: new columns from `other`, joined on keys or by position."""
    extend_with = [c for c in other_header if c not in header]
    if not extend_with:
        return
    header.extend(extend_with)
    for row in rows:
        for c in extend_with:
            row[c] = ""
    if not keys:
        for row1, row2 in zip(rows, other_rows):
            for c in extend_with:
                row1[c] = row2[c]
        return
    for row1 in rows:
        for row2 in other_rows:
            if all(row1[k] == row2.get(k) for k in keys):
                for c in extend_with:
                    row1[c] = row2[c]
                break


def parse(parser: str, raw: str, also: Optional[list[str]] = None) -> list[dict]:
    """Rows for `raw` under `parser` (and `also` templates); ParseError when it cannot be read."""
    if parser in ("raw", "none", "regex", "api"):
        return []
    if parser == "json":
        try:
            value = json.loads(raw)
        except json.JSONDecodeError as e:
            raise ParseError(f"json: {e.msg} at line {e.lineno}") from None
        return value if isinstance(value, list) and all(isinstance(v, dict) for v in value) else [{"json": value}]
    if parser == "xml":
        return [{"xml": raw}]
    if parser.startswith("textfsm:"):
        header, keys, rows = _textfsm(parser[len("textfsm:"):], raw)
        for extra in also or []:
            if not extra.startswith("textfsm:"):
                raise ParseError(f"also: {extra!r} is not a textfsm template")
            other_header, _, other_rows = _textfsm(extra[len("textfsm:"):], raw)
            _extend(header, rows, keys, other_header, other_rows)
        return rows
    if parser.startswith("genie:"):
        raise ParseError("genie is not bundled (D-060: only for a named gap)")
    raise ParseError(f"unknown parser {parser!r}")
