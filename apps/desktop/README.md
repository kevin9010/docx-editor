# SuperDoc Desktop

This package is the Tauri 2 adapter for the SuperDoc browser editor. It keeps the existing VS Code adapter separate while reusing `packages/superdoc` for DOCX rendering and editing.

## Development

From the repository root:

```bash
pnpm install
pnpm dev:desktop
```

The web-only preview can be started with:

```bash
pnpm --filter superdoc-desktop dev:web
```

The native build requires the Rust toolchain and Windows WebView2. The Tauri Windows bundle uses the WebView2 bootstrapper install mode so a clean machine can install the runtime when it is missing. The final installer still needs to be tested on clean Windows 10 and Windows 11 machines before release.

A Windows portable ZIP can be created on a Windows host with:

```bash
pnpm package:desktop:portable
```

The script builds the Tauri executable with `--no-bundle`, stages it with a version manifest and `PORTABLE-README.txt`, and writes a SHA-256 checksum under `artifacts/desktop/`. This is a small portable distribution, not a self-contained runtime: the Evergreen WebView2 Runtime must already be installed, and the executable does not download it. Use the regular Tauri installer when WebView2 installation is required. The current portable artifact is intentionally unsigned until a Windows Authenticode signing certificate is configured.

## Windows CI artifacts

The `Desktop Windows` GitHub Actions workflow validates and packages relevant pull requests and pushes to `main`. Its path filters include desktop sources, workspace packages, shared code, build scripts, and root build configuration. After the workflow is merged into the default branch, it can also be started from **Actions > Desktop Windows > Run workflow** with a selected branch.

The job installs locked dependencies, builds SuperDoc, runs desktop type checks, tests and lint, checks Rust formatting, runs Clippy and Rust tests, and builds the MSI, NSIS installer, and portable ZIP. Before upload, it checks that both installer formats exist, verifies the ZIP's SHA-256, and checks the packaged manifest's version, commit, encoding, and executable architecture.

Download `superdoc-desktop-windows-<commit>` from the completed run's **Artifacts** section. It contains the `.msi`, `-setup.exe`, `-portable.zip`, and `.zip.sha256` deliverables. Extract the portable ZIP to run `SuperDoc-Desktop.exe`; the installers and portable build have the WebView2 and signing limitations described above.

To repeat artifact verification locally after packaging, run from the repository root:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File apps/desktop/scripts/verify-windows-artifacts.ps1
```

## Opening documents

Use **Open** to pick a `.docx` file with the system dialog, or drag a `.docx` file from Explorer onto the window. Both routes replace the current document and ask first when there are unsaved changes. The file is read on this machine; nothing leaves it until the Agent is used.

## Agent behavior

The Agent operates on the currently visible SuperDoc instance through its browser Document API. It can inspect bounded document text, replace matching text as a tracked change, and add comments. It cannot accept or reject tracked changes. Agent edits are not automatically saved; the user reviews them in the editor and chooses Save.

Model requests are sent by the Rust Tauri command to the configured OpenAI-compatible Chat Completions endpoint. `baseUrl` and model name are stored as non-secret convenience settings. The API key is kept in memory for the current window only and is not written to local storage or application logs. The document context is sent to the endpoint selected by the user.

Codex CLI, Claude CLI, MCP, and the headless SuperDoc SDK are intentionally not required to launch the desktop application. They can be added as optional developer backends later without duplicating the live editor document state.

## Scope and release notes

The current implementation is a POC for local DOCX open/edit/save and a reviewable document Agent. File association, crash recovery, signed installers, automatic updates, Credential Manager integration, and a full external-file conflict UI remain release-hardening work. SuperDoc is AGPL-licensed in this repository; review the applicable licensing options before distributing a closed-source desktop product.
