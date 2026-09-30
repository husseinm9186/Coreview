"""
One SSH session per device, driven by scrapli. The catalog's `session:`
block (passed by Rust as `session_spec` on `open`) supplies every literal
this module sends that is not a collection command: the banner answer,
the paging steps, the context switches. Nothing else is typed here.

Phase 1 uses scrapli's own platform drivers for the prompt and privilege
handling they encode (the same data the catalog carries, extracted by
scripts/extract-sessions.py); an OS with no scrapli platform (ArubaOS-
Switch) runs on scrapli's GenericDriver with the catalog's prompt pattern.
"""
from __future__ import annotations

import base64
import hashlib
import re
import time
from typing import Any, Optional

from scrapli import Scrapli
from scrapli.driver import GenericDriver
from scrapli.exceptions import ScrapliAuthenticationFailed, ScrapliConnectionError, ScrapliTimeout

from .allowlist import verdict

# Coreview catalog os → scrapli platform. None: GenericDriver with the catalog's prompt.
PLATFORMS = {
    "cisco_ios": "cisco_iosxe",
    "cisco_nxos": "cisco_nxos",
    "cisco_iosxr": "cisco_iosxr",
    "arista_eos": "arista_eos",
    "juniper_junos": "juniper_junos",
    "fortios": "fortinet_fortios",
    # LT-565: FortiSwitchOS shares FortiOS's shell.
    "fortiswitch": "fortinet_fortios",
    "panos": "paloalto_panos",
    "aoscx": "aruba_aoscx",
    "aoss": None,
    "cisco_asa": "cisco_asa",
    "cisco_ftd": "cisco_ftd",
    "cisco_wlc_aireos": "cisco_aireos",
    "hpe_comware": "hp_comware",
    "huawei_vrp": "huawei_vrp",
    "mikrotik_routeros": "mikrotik_routeros",
    "cumulus": "cumulus_linux",
    "ruckus_icx": "ruckus_fastiron",
    "ubiquiti_edgeos": "vyos_vyos",
}

# The only shapes a session step may take. A catalog is data Rust controls,
# but a step outside this vocabulary is still refused here and reported.
SESSION_STEP = re.compile(
    r"^(terminal |term |set cli |no page$|config paging (disable|enable)$|screen-length|screen-width|skip-page-display$|stty cols "
    r"|config system console$|set output \S+$|end$|abort$|config global$|config vdom$|edit \S+$|changeto (context \S+|system)$"
    r"|set system setting target-vsys \S+$|enable$|exit$|logout$|quit$|a$|y$|n$|\r?$)"
)


def fingerprint_of(key) -> str:
    """OpenSSH's SHA-256 fingerprint, the form Coreview's host-key store keeps:
    `SHA256:` and the unpadded base64 of the digest of the key blob."""
    digest = hashlib.sha256(key.asbytes()).digest()
    return "SHA256:" + base64.b64encode(digest).decode().rstrip("=")


class SessionError(Exception):
    def __init__(self, status: str, message: str):
        super().__init__(message)
        self.status = status


def _fill(step: str, name: str, kind: str) -> str:
    return step.replace("{" + kind + "}", name).replace("{vrf}", name).replace("{vdom}", name).replace("{vsys}", name).replace("{ctx}", name).replace("{context}", name)


class Session:
    def __init__(self, sid: str, host: str, port: int, os_name: str, auth: dict, spec: dict, timeouts: dict, emit, known_key: Optional[str] = None):
        self.id = sid
        self.host = host
        self.os = os_name
        self.spec = spec or {}
        self.emit = emit
        self.contexts: list[str] = []
        self.context_kind: Optional[str] = None
        self.has_contexts = False
        self._original_paging: Optional[str] = None
        self._current_context: Optional[str] = None
        # LT-529: the fingerprint Coreview's store holds for this host, if any,
        # and the one the device presented.
        self.known_key = known_key
        self.presented_key: Optional[str] = None
        connect_s = max(1, int(timeouts.get("connect_ms", 8000))) / 1000
        auth_s = max(1, int(timeouts.get("auth_ms", 20000))) / 1000
        common: dict[str, Any] = {
            "host": host,
            "port": port,
            "auth_username": auth["username"],
            "auth_password": auth.get("password") or "",
            "auth_secondary": auth.get("enable") or auth.get("password") or "",
            "auth_private_key": auth.get("private_key") or "",
            "auth_private_key_passphrase": auth.get("passphrase") or "",
            # LT-529: strict, with the check replaced below by one against
            # Coreview's own store — the sidecar keeps no known_hosts file.
            "auth_strict_key": True,
            "transport": "paramiko",
            "timeout_socket": connect_s,
            "timeout_transport": auth_s,
            "timeout_ops": 30,
        }
        platform = PLATFORMS.get(os_name)
        self.enable_secret = common["auth_secondary"]
        if platform is None:
            # "generic" (the fingerprint pass, before the OS is known) and any OS
            # without a scrapli platform run on the GenericDriver with the
            # catalog's prompt pattern, or a loose one that matches every CLI.
            # GenericDriver knows no privilege levels, so no auth_secondary.
            del common["auth_secondary"]
            prompt = self.spec.get("prompt_pattern") or r"^.*[>#$%\]]\s*$"
            self.conn = GenericDriver(comms_prompt_pattern=prompt, **common)
            self.generic = True
        else:
            try:
                self.conn = Scrapli(platform=platform, **common)
            except TypeError as e:
                # LT-560: some scrapli platforms (fortinet_fortios) are built on
                # the generic driver, which knows no privilege levels and takes
                # no enable secret.
                if "auth_secondary" not in str(e):
                    raise
                del common["auth_secondary"]
                self.conn = Scrapli(platform=platform, **common)
            self.generic = False
        self.conn.transport._verify_key = self._verify_key

    # ------------------------------------------------------------- host key

    def _verify_key(self) -> None:
        """Called by the transport after the key exchange and before any
        credential is sent. A key that is not the one Coreview remembers stops
        the session here, so the password never reaches the device."""
        key = self.conn.transport.session.get_remote_server_key()
        self.presented_key = fingerprint_of(key)
        if self.known_key and self.known_key != self.presented_key:
            raise SessionError(
                "host_key",
                f"The SSH host key for {self.host} is not the one Coreview remembered "
                f"(remembered {self.known_key}, presented {self.presented_key}). Nothing was sent.",
            )

    # ------------------------------------------------------------- lifecycle

    def open(self) -> dict:
        try:
            self.conn.open()
        except SessionError:
            raise
        except ScrapliAuthenticationFailed as e:
            raise SessionError("auth", str(e)) from None
        except ScrapliTimeout as e:
            raise SessionError("timeout", str(e)) from None
        except (ScrapliConnectionError, OSError) as e:
            raise SessionError("error", str(e)) from None
        if self.generic:
            if self.os == "generic":
                # LT-561: the pass that recognises a device knows nothing of it
                # yet, and a Catalyst's `show version` stops at --More--, where
                # the switch drops the session. Most CLIs take this; the rest
                # answer with an error, which is ignored.
                try:
                    self.conn.send_command("terminal length 0", timeout_ops=10)
                except Exception:  # noqa: BLE001 — a device that does not know it is still recognised
                    pass
            self._generic_on_open()
        self._detect_contexts()
        self._disable_paging()
        return {
            "prompt": self._prompt(),
            "contexts": self.contexts,
            "context_kind": self.context_kind,
            "host_key": self.presented_key,
            "host_key_first_seen": not self.known_key,
        }

    def close(self) -> None:
        try:
            self._restore_paging()
        except Exception:  # noqa: BLE001 — closing must not fail on a device that already went away
            pass
        try:
            self.conn.close()
        except Exception:  # noqa: BLE001
            pass

    def _prompt(self) -> str:
        try:
            return self.conn.get_prompt()
        except Exception:  # noqa: BLE001
            return ""

    # ---------------------------------------------------------------- steps

    def _step(self, step: str, timeout: float = 15) -> str:
        """Send one session step from the catalog; refuse anything outside the vocabulary."""
        if not SESSION_STEP.match(step):
            raise SessionError("refused", f"session step {step!r} is outside the session vocabulary")
        r = self.conn.send_command(step, timeout_ops=timeout)
        return r.result

    def _generic_on_open(self) -> None:
        banner = self.spec.get("banner")
        if banner:
            # ProCurve: "Press any key to continue" before the prompt (netmiko hp_procurve.py).
            self.conn.channel.send_return()
            time.sleep(0.5)
        levels = self.spec.get("privilege_levels") or {}
        want = self.spec.get("default_privilege")
        lvl = levels.get(want) if want else None
        if lvl and lvl.get("escalate"):
            prompt = self._prompt()
            if not re.search(lvl["pattern"], prompt):
                self.conn.send_interactive(
                    [(lvl["escalate"], lvl.get("escalate_prompt") or "assword", False), (self.enable_secret, "", True)] if lvl.get("escalate_auth") else [(lvl["escalate"], "", False)],
                    timeout_ops=15,
                )
        for step in (self.spec.get("paging") or {}).get("off") or self.spec.get("on_open") or []:
            self._step(step)

    def _detect_contexts(self) -> None:
        ctx = self.spec.get("contexts")
        if not ctx:
            return
        self.context_kind = ctx.get("kind")
        detect = ctx.get("detect") or {}
        if not detect.get("cmd"):
            return
        out = self._run_raw(detect["cmd"], 15)
        if not re.search(detect.get("match", "$^"), out, re.M):
            return
        self.has_contexts = True
        lst = ctx.get("list") or {}
        if lst.get("cmd"):
            out = self._run_raw(lst["cmd"], 15)
            self.contexts = sorted(set(re.findall(lst.get("match", "$^"), out, re.M)))
        self.emit("log", level="info", msg=f"{self.context_kind}: {len(self.contexts)} found")

    def _disable_paging(self) -> None:
        paging = self.spec.get("paging") or {}
        check = paging.get("check")
        if check and check.get("cmd"):
            # FortiOS: read the console output mode, set standard only if it is not, restore on close.
            if check.get("in_global") and self.has_contexts:
                self._enter_global()
            out = self._run_raw(check["cmd"], 15)
            m = re.search(check.get("match", "$^"), out, re.M)
            self._original_paging = m.group(1) if m else None
            if self._original_paging != check.get("want"):
                for step in paging.get("off") or []:
                    self._step(step)
            if check.get("in_global") and self.has_contexts:
                self._leave_context()
        # Platforms scrapli knows already ran their own on_open; the generic path ran the steps above.

    def _restore_paging(self) -> None:
        paging = self.spec.get("paging") or {}
        check = paging.get("check")
        if not check or self._original_paging is None or self._original_paging == check.get("want"):
            return
        if check.get("in_global") and self.has_contexts:
            self._enter_global()
        for step in paging.get("restore") or []:
            self._step(step.replace("{original}", self._original_paging))
        if check.get("in_global") and self.has_contexts:
            self._leave_context()

    # ------------------------------------------------------------- contexts

    def _enter_global(self) -> None:
        for step in (self.spec.get("contexts") or {}).get("enter_global") or []:
            self._step(step)
        self._current_context = "global"

    def _leave_context(self) -> None:
        ctx = self.spec.get("contexts") or {}
        if self._current_context is None:
            return
        for step in ctx.get("leave") or []:
            self._step(step)
        self._current_context = None
        if ctx.get("reprompt"):
            self._prompt()

    def switch(self, context: dict) -> dict:
        """Enter a VDOM / vsys / ASA context, `global`, or `system` (none)."""
        ctx = self.spec.get("contexts")
        if not ctx:
            raise SessionError("unsupported", f"{self.os} has no contexts")
        name = context.get("name")
        self._leave_context()
        if name in (None, "system", ""):
            return {"context": None}
        if name == "global":
            self._enter_global()
            return {"context": "global"}
        if self.has_contexts and self.contexts and name not in self.contexts:
            raise SessionError("unsupported", f"no {self.context_kind} named {name!r}")
        for step in ctx.get("enter") or []:
            self._step(_fill(step, name, ctx.get("kind", "context")))
        self._current_context = name
        if ctx.get("reprompt"):
            self._prompt()
        return {"context": name}

    # ------------------------------------------------------------- commands

    def _run_raw(self, cmd: str, timeout: float) -> str:
        v = verdict(cmd)
        if v != "ok":
            raise SessionError("refused", v)
        r = self.conn.send_command(cmd, timeout_ops=timeout)
        return r.result

    def _failed_when(self) -> list[str]:
        """Scrapli's refusals for the platform and the catalog's own (LT-568)."""
        ours = [m for m in self.spec.get("failed_when_contains") or [] if m]
        return list(dict.fromkeys(list(getattr(self.conn, "failed_when_contains", None) or []) + ours))

    def run(self, cmd: str, timeout_ms: int) -> tuple[str, str, int]:
        """(status, raw, duration_ms) for one collection command."""
        v = verdict(cmd)
        if v != "ok":
            raise SessionError("refused", v)
        started = time.monotonic()
        try:
            r = self.conn.send_command(cmd, timeout_ops=max(1, timeout_ms) / 1000, failed_when_contains=self._failed_when())
        except ScrapliTimeout:
            return "timeout", "", int((time.monotonic() - started) * 1000)
        except (ScrapliConnectionError, OSError) as e:
            raise SessionError("error", f"connection lost: {e}") from None
        ms = int((time.monotonic() - started) * 1000)
        status = "unsupported" if r.failed else "ok"
        return status, r.result, ms
