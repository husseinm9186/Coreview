# Signing the Windows installer

The root certificate that signs these builds is published as
`brand/coreview-root-ca.crt`. It is the **public** certificate — there is no
private key in it, and there must never be one in this repository. Installing
it as a trusted root is what makes a signed Coreview installer show
"COREVIEW-APP" as the publisher instead of "Unknown Publisher"; it does nothing
about SmartScreen, for the reasons below.

## What the current certificate does, and does not, do

The certificate in hand is issued by **COREVIEW-APP-Root-CA** — an internal
CA, not one in the Microsoft Trusted Root Program. Its extended key usage is
`Code Signing` (critical) and it runs to August 2036, so it signs correctly.
What that is worth depends entirely on who is running the installer.

| | Machine that trusts COREVIEW-APP-Root-CA | Any other machine |
| --- | --- | --- |
| Signature validates | Yes | No |
| Publisher shown | COREVIEW | "Unknown Publisher" |
| Tamper-evident | Yes | Yes — the hash is still checked |
| SmartScreen warning | Still possible on a new file | **Yes, unchanged** |

SmartScreen reputation attaches to the signing certificate, and an internal CA
has none with Microsoft and cannot earn any. Signing with this certificate is
worth doing — it is free, it proves the installer came from you and has not
been altered, and it names the publisher on managed machines. It does not make
the warning go away for anyone outside the estate, and no amount of
configuration changes that.

**Decision, 2026-09-29: Coreview stays on this certificate.** No public-CA
certificate and no cloud signing service. What a customer does to trust it,
and what that does and does not change for SmartScreen and Defender, is in
`docs/INSTALL-WINDOWS.md`; the public root and signing certificates travel
beside every installer.

## Setting it up

Two repository secrets, at **Settings → Secrets and variables → Actions**:

| Secret | Value |
| --- | --- |
| `WINDOWS_CERTIFICATE` | `base64 -w0 coreview-codesign.pfx` |
| `WINDOWS_CERTIFICATE_PASSWORD` | the PFX password |

The thumbprint is read back from the certificate after it is imported
rather than kept as a constant here, so replacing the certificate needs no
change to the repository.

A third secret belongs to the in-app updater rather than to Authenticode:

| Secret | Value |
| --- | --- |
| `TAURI_SIGNING_PRIVATE_KEY` | the minisign private key `tauri signer generate` wrote |

With it set, `tauri build` writes a `.sig` beside the Windows installer and
beside the macOS update archive (`tauri.updater.conf.json` switches that
on), and the `release` job attaches them with `latest.json`. The matching
public key is `plugins.updater.pubkey` in `tauri.conf.json`; an installed
copy refuses any update whose signature does not verify against it. Losing
the private key means every installed copy stops being able to update
itself and has to be reinstalled by hand, so it is kept off the repository
and backed up like the certificate. It is a different key from the code
signing certificate: the installer is signed by both.

With no secrets configured — forks, pull requests, or before this is set up —
the build says so and produces an unsigned installer rather than failing.

## What the build does

`.github/actions/sign-windows` imports the PFX into the runner's certificate
store, deletes the file, and points the Tauri bundler at the imported key by
thumbprint. Signatures are timestamped against
`http://timestamp.digicert.com`: without a timestamp a signature stops
validating the day the certificate expires, and an installer outlives that.

The installer is signed, and so is the offline installer when that job is
switched on, and so is every PE inside the collector sidecar that its
publisher has not already signed (`sidecar/build/sign.ps1`). Each installer is then
scanned on VirusTotal and fails the build on any detection; its SHA-256 goes
into `SHA256SUMS.txt`, and CycloneDX SBOMs into `sbom/`.

## Checking a build

On Windows:

```powershell
Get-AuthenticodeSignature .\Coreview_2.7.1_x64-setup.exe | Format-List
```

`Status` reads `Valid` on a machine that trusts the root, and
`UnknownError` / `NotTrusted` on one that does not — which is the expected
result outside the estate, not a fault in the build.
