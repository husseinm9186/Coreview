# Installing Coreview on Windows

Coreview's Windows installer is signed with the **Coreview certificate** —
`CN=COREVIEW-APP Code Signing`, issued by Coreview's own root,
`CN=COREVIEW-APP-Root-CA` (valid to August 2036). It is not a certificate
from a public authority, so a Windows machine does not trust it until the
root is added. This page is how a customer's administrator does that, what
it changes, and what it does not.

## What comes with each build

From a green CI run's `coreview-windows` artifact:

| File | What it is |
| --- | --- |
| `Coreview_<version>_x64-setup.exe` | The installer. Signed, timestamped. |
| `SHA256SUMS.txt` | The installer's SHA-256, recorded after the VirusTotal scan passed. |
| `coreview-root-ca.crt` | The root's **public** certificate (also in the repository at `brand/`). |
| `coreview-code-signing.cer` | The signing certificate's **public** half. |
| `sbom/*.cdx.json` | CycloneDX software bills of materials: the Rust executable, the collector sidecar's Python, the page's npm packages. |

No private key is ever in any of these.

## 1. Check the file is the one that was built

```powershell
(Get-FileHash .\Coreview_2.4.9_x64-setup.exe -Algorithm SHA256).Hash.ToLower()
Get-Content .\SHA256SUMS.txt
```

The two must be equal. Compare the root's thumbprint too before trusting it:

```powershell
(Get-PfxCertificate .\coreview-root-ca.crt).Thumbprint
# 4D50912F3C816E30DAC9E3C7178CFF97B0FB431D
```

## 2. Trust the certificate

Both stores, on the machine (not the user):

- the **root** into *Trusted Root Certification Authorities*, so the
  signature chains to something Windows trusts;
- the **signing certificate** into *Trusted Publishers*, so Windows treats
  software signed with it as from a trusted publisher without asking.

On one machine, as administrator:

```powershell
Import-Certificate -FilePath .\coreview-root-ca.crt       -CertStoreLocation Cert:\LocalMachine\Root
Import-Certificate -FilePath .\coreview-code-signing.cer  -CertStoreLocation Cert:\LocalMachine\TrustedPublisher
```

or with `certutil`:

```bat
certutil -addstore -f Root coreview-root-ca.crt
certutil -addstore -f TrustedPublisher coreview-code-signing.cer
```

Across an estate, Group Policy: *Computer Configuration → Policies →
Windows Settings → Security Settings → Public Key Policies*, then import the
root under **Trusted Root Certification Authorities** and the signing
certificate under **Trusted Publishers**.

Check it took:

```powershell
Get-AuthenticodeSignature .\Coreview_2.4.9_x64-setup.exe | Format-List Status, SignerCertificate
```

`Status : Valid`, signer `CN=COREVIEW-APP Code Signing`. Before step 2 the
same command says `UnknownError` — expected, not a broken build.

## 3. SmartScreen and Microsoft Defender — what trusting the certificate does and does not do

Being plain about this, because it is the question every administrator asks:

- **User Account Control** shows *Verified publisher: COREVIEW-APP* instead
  of *Unknown*. That is what the two stores above change.
- **Defender SmartScreen**'s "Windows protected your PC" prompt is decided
  by *reputation*, which Microsoft keeps for certificates from public
  authorities. A private certificate has none and cannot earn any, and
  adding it to the stores above does **not** give it any. SmartScreen only
  looks at files that carry the *Mark of the Web* — files downloaded through
  a browser. So:
  - on one machine, clear the mark before running it:
    `Unblock-File .\Coreview_2.4.9_x64-setup.exe` (or *Properties →
    Unblock*);
  - across an estate, deploy the installer the way managed software is
    deployed — Intune, Configuration Manager, a file share, a GPO software
    installation — none of which set the mark, so SmartScreen never asks.
- **Microsoft Defender Antivirus** scans the installer like any file. Each
  build's installer has already passed VirusTotal with no detection before it
  was published (the build fails otherwise). Organisations on **Defender for
  Endpoint** can add an *Allow* indicator for the signing certificate
  (*Settings → Endpoints → Indicators → Certificates*, upload
  `coreview-code-signing.cer`), which tells Defender to allow files signed
  with it.
- **App Control for Business / WDAC** estates add a publisher rule for the
  signing certificate in their policy.

If the SmartScreen prompt itself must go away for machines nobody manages,
that takes a certificate from a public authority; the decision on record
(2026-09-29) is to stay on the Coreview certificate.

- **Chrome may refuse the download outright** — "This file is dangerous",
  with no *Keep* button. That is Google Safe Browsing's download
  protection, which judges an installer by the reputation of its signing
  certificate and finds none for a private one; it is the same verdict a
  public certificate would cure, and nothing in the build changes it. Each
  build has passed VirusTotal before it was published, so it is not a
  detection. Three ways past it, from best to worst:
  1. Fetch the artifact without a browser. From a terminal with the GitHub
     CLI signed in: `gh run download <run id> -n coreview-windows -R
     <owner>/<repo>` (the run id is in the Actions URL). Nothing is
     flagged, and the file arrives without the Mark of the Web.
  2. Download with Edge, which warns but offers *Keep*.
  3. In Chrome, *chrome://settings/security* → Safe Browsing → *No
     protection* for the one download, then put it back. Do not leave it off.
  Google takes false-positive reports at
  https://safebrowsing.google.com/safebrowsing/report_error/; they do not
  change the verdict quickly, and only a public certificate changes it for
  good.

## 4. Install

Run the installer (per-machine; it asks for elevation). It installs the
collector sidecar — a private copy of Python with its own libraries — in
its own folder inside the installation directory. It is used only by
Coreview, is not put on `PATH`, and is removed with Coreview.
