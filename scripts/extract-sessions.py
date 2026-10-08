#!/usr/bin/env python3
"""
The per-OS session behaviour — prompt patterns per privilege level,
how to escalate, what to send on open, what a failed command looks like —
read from the scrapli and scrapli_community drivers the sidecar runs, and
written as JSON for scripts/build-catalog.mjs to place in each catalog's
`session:` block. Nothing here is typed from memory: every field names
the class it came from. What scrapli does not encode (FortiOS VDOM and
console mode, ASA contexts, PAN-OS vsys, the WLC's login prompt, the
ProCurve "any key to continue") is added in build-catalog.mjs from
netmiko's drivers, each with its source named.

    <venv>/bin/python scripts/extract-sessions.py > resources/catalog/sessions.json
"""
import importlib
import inspect
import json
import re
import sys

DRIVERS = {
    "cisco_ios": ("scrapli.driver.core", "IOSXEDriver"),
    "cisco_nxos": ("scrapli.driver.core", "NXOSDriver"),
    "cisco_iosxr": ("scrapli.driver.core", "IOSXRDriver"),
    "arista_eos": ("scrapli.driver.core", "EOSDriver"),
    "juniper_junos": ("scrapli.driver.core", "JunosDriver"),
    "fortios": ("scrapli_community.fortinet.fortios.fortinet_fortios", "SCRAPLI_PLATFORM"),
    "panos": ("scrapli_community.paloalto.panos.paloalto_panos", "SCRAPLI_PLATFORM"),
    "aoscx": ("scrapli_community.aruba.aoscx.aruba_aoscx", "SCRAPLI_PLATFORM"),
    "cisco_asa": ("scrapli_community.cisco.asa.cisco_asa", "SCRAPLI_PLATFORM"),
    "cisco_ftd": ("scrapli_community.cisco.ftd.cisco_ftd", "SCRAPLI_PLATFORM"),
    "cisco_wlc_aireos": ("scrapli_community.cisco.aireos.cisco_aireos", "SCRAPLI_PLATFORM"),
    "hpe_comware": ("scrapli_community.hp.comware.hp_comware", "SCRAPLI_PLATFORM"),
    "huawei_vrp": ("scrapli_community.huawei.vrp.huawei_vrp", "SCRAPLI_PLATFORM"),
    "mikrotik_routeros": ("scrapli_community.mikrotik.routeros.mikrotik_routeros", "SCRAPLI_PLATFORM"),
    "cumulus": ("scrapli_community.cumulus.linux.cumulus_linux", "SCRAPLI_PLATFORM"),
    "ruckus_icx": ("scrapli_community.ruckus.fastiron.ruckus_fastiron", "SCRAPLI_PLATFORM"),
    "vyos": ("scrapli_community.vyos.vyos.vyos", "SCRAPLI_PLATFORM"),
}
# aoss (ArubaOS-Switch / ProCurve) and ubiquiti_edgeswitch have no scrapli
# platform in the pinned release; their session blocks come from netmiko's
# hp_procurve.py and ubiquiti_edgeswitch.py, cited in build-catalog.mjs.

# Methods whose source is kept beside the extracted fields, so the session
# steps written by hand in build-catalog.mjs can be checked against them.
KEEP_SOURCE = {
    "fortios": ["_vdoms_status", "prepare_session", "cleanup_session", "_to_system", "gather_vdoms", "context"],
    "mikrotik_routeros": ["send_command"],
}

SEND = re.compile(r'(?:send_command|send_input|send_inputs?|write)\(\s*(?:command|channel_input|input)?=?\s*(?:\[)?\s*"([^"]+)"')


def sent_commands(fn):
    """The literal commands an on_open/on_close function sends, in order."""
    try:
        src = inspect.getsource(fn)
    except (OSError, TypeError):
        return []
    return SEND.findall(src)


def privs_of(privs):
    out = {}
    for name, p in privs.items():
        out[name] = {
            "pattern": p.pattern,
            "previous": p.previous_priv,
            "escalate": p.escalate,
            "escalate_auth": p.escalate_auth,
            "escalate_prompt": p.escalate_prompt,
            "deescalate": p.deescalate,
            "not_contains": list(p.not_contains or []),
        }
    return out


def from_core(cls):
    d = {
        "source": f"scrapli {cls.__module__}.{cls.__name__}",
        "privilege_levels": {},
        "default_privilege": None,
        "failed_when_contains": [],
        "on_open": [],
        "on_close": [],
    }
    mod = importlib.import_module(cls.__module__.rsplit(".", 1)[0] + ".base_driver")
    d["privilege_levels"] = privs_of(mod.PRIVS)
    for attr in ("DEFAULT_DESIRED_PRIVILEGE_LEVEL",):
        if hasattr(mod, attr):
            d["default_privilege"] = getattr(mod, attr)
    if hasattr(mod, "FAILED_WHEN_CONTAINS"):
        d["failed_when_contains"] = list(mod.FAILED_WHEN_CONTAINS)
    sync_mod = importlib.import_module(cls.__module__.rsplit(".", 1)[0] + ".sync_driver")
    for fname, key in (("iosxe_on_open", "on_open"), ("nxos_on_open", "on_open"), ("iosxr_on_open", "on_open"), ("eos_on_open", "on_open"), ("junos_on_open", "on_open"),
                       ("iosxe_on_close", "on_close"), ("nxos_on_close", "on_close"), ("iosxr_on_close", "on_close"), ("eos_on_close", "on_close"), ("junos_on_close", "on_close")):
        if hasattr(sync_mod, fname):
            d[key] = sent_commands(getattr(sync_mod, fname))
            d[key + "_source"] = f"{sync_mod.__name__}.{fname}"
    return d


def from_community(platform, os_name):
    defaults = platform["defaults"]
    driver = platform.get("driver_type")
    if isinstance(driver, dict):
        cls = driver["sync"]
        source = f"scrapli_community {cls.__module__}.{cls.__name__}"
    else:
        source = f"scrapli_community generic '{driver}' driver"
    d = {
        "source": source,
        "prompt_pattern": defaults.get("comms_prompt_pattern"),
        "privilege_levels": privs_of(defaults.get("privilege_levels", {})),
        "default_privilege": defaults.get("default_desired_privilege_level"),
        "failed_when_contains": list(defaults.get("failed_when_contains", [])),
        "on_open": sent_commands(defaults.get("sync_on_open")) if defaults.get("sync_on_open") else [],
        "on_close": sent_commands(defaults.get("sync_on_close")) if defaults.get("sync_on_close") else [],
    }
    if defaults.get("sync_on_open"):
        d["on_open_source"] = f"{defaults['sync_on_open'].__module__}.{defaults['sync_on_open'].__name__}"
    if defaults.get("sync_on_close"):
        d["on_close_source"] = f"{defaults['sync_on_close'].__module__}.{defaults['sync_on_close'].__name__}"
    if "textfsm_platform" in defaults:
        d["ntc_platform"] = defaults["textfsm_platform"]
    if "genie_platform" in defaults:
        d["genie_platform"] = defaults["genie_platform"]
    if isinstance(driver, dict) and os_name in KEEP_SOURCE:
        d["method_source"] = {}
        for name in KEEP_SOURCE[os_name]:
            fn = getattr(driver["sync"], name, None)
            if fn is not None:
                d["method_source"][name] = inspect.getsource(fn)
    return d


def main():
    out = {}
    for os_name, (module, attr) in DRIVERS.items():
        try:
            mod = importlib.import_module(module)
            obj = getattr(mod, attr)
        except Exception as e:  # noqa: BLE001 — a missing community platform is reported, not hidden
            out[os_name] = {"error": f"{module}.{attr}: {e}"}
            continue
        out[os_name] = from_community(obj, os_name) if isinstance(obj, dict) else from_core(obj)
        if not isinstance(obj, dict):
            out[os_name]["ntc_platform"] = getattr(obj, "textfsm_platform", None) or {
                "cisco_ios": "cisco_ios", "cisco_nxos": "cisco_nxos", "cisco_iosxr": "cisco_xr", "arista_eos": "arista_eos", "juniper_junos": "juniper_junos"
            }[os_name]
    import scrapli, scrapli_community  # noqa: E401
    out["_versions"] = {"scrapli": scrapli.__version__, "scrapli_community": scrapli_community.__version__}
    json.dump(out, sys.stdout, indent=1, sort_keys=True)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
