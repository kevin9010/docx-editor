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

The job installs locked dependencies, builds SuperDoc, runs desktop type checks, tests and lint, checks Rust formatting, runs Clippy and Rust tests, and builds the MSI, NSIS installer, and portable ZIP. Browser checks open a DOCX at four window widths, exercise toolbar scrolling and dropdowns beside the Agent, and verify progress and cancellation during slow provider responses. Before upload, it checks that both installer formats exist, verifies the ZIP's SHA-256, and checks the packaged manifest's version, commit, encoding, and executable architecture.

Download `superdoc-desktop-windows-<commit>` from the completed run's **Artifacts** section. It contains the `.msi`, `-setup.exe`, `-portable.zip`, and `.zip.sha256` deliverables. Extract the portable ZIP to run `SuperDoc-Desktop.exe`; the installers and portable build have the WebView2 and signing limitations described above.

To repeat artifact verification locally after packaging, run from the repository root:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File apps/desktop/scripts/verify-windows-artifacts.ps1
```

## Opening documents

Use **Open** to pick a `.docx` file with the system dialog, or drag a `.docx` file from Explorer onto the window. Both routes replace the current document and ask first when there are unsaved changes. The file is read on this machine; nothing leaves it until the Agent is used.

## Writing and reviewing

The SuperDoc toolbar stays inside the editor column and scrolls horizontally using its arrows, scrollbar, or mouse wheel. The rounded Agent card occupies the right column from toolbar level to the bottom, with its own scroll area and a matching shadow/background. Hiding it returns that space to the document.

Select a passage in SuperDoc to work on that passage, or choose **Whole document**. Set any optional instructions or output language, then click **Revise**, **Polish**, **Proofread**, **Academic**, **Translate**, or **Summarize** to start immediately. The captured selection survives moving focus to the Agent. Translation requires a target language. Summarize returns a response without requesting a rewrite. **Custom** selects free-form instructions; use **Generate suggestions** to run them or repeat the selected action.

**Generate suggestions** reads document context and creates previews of the original and suggested text. Nothing is written by the model. **Apply as revision** creates a tracked replacement; **Add comment** creates a review comment. Use SuperDoc's own review controls to accept or reject changes. **Dismiss** leaves the document unchanged. Starting another run replaces the previous suggestion list.

Progress stays at the top while the settings and suggestions scroll independently. Both connection checks and runs show the current phase, elapsed time, and an activity log. Runs also show incoming response text and tool progress. After 20 seconds without new activity, the UI explicitly reports that it is waiting; this does not claim the model has failed. **Stop** cancels immediately and keeps received text and proposals available. Codex provider retries and errors are surfaced; a run stops after two minutes of inactivity or five minutes total. Reasoning events count as activity without displaying raw reasoning. Normal generation checks the existing login but skips model discovery; the explicit connection check loads the model list.

The app rejects stale document revisions and ambiguous whole-document matches. Selected-passage edits use the captured range, even if the same text occurs elsewhere. It limits a selected passage to 12,000 characters and a run to 16 suggestions; whole-document inspection is paginated. Applied Agent changes pause auto-save until the user explicitly saves. Document replacement and saving are disabled during an Agent run or application.

### Local Codex CLI (default)

The app starts the already-installed `codex app-server --listen stdio://` and reuses its authentication and model configuration. It does not download or bundle Codex or read API keys from Codex's credential files. **Connection settings > Check connection** reports availability and loads the model list; **CLI default** preserves the CLI's configured model. If PATH discovery fails, specify an absolute installed `codex.exe` or npm `codex.cmd` path. npm shims are resolved to their native executable without invoking a shell. If signed out, run `codex login` separately and reconnect.

The bridge uses the [official Codex app-server protocol](https://developers.openai.com/codex/app-server). Dynamic document tools require an app-server version supporting `dynamicTools`, `item/tool/call`, and `environments: []`; the local integration test was validated with Codex 0.167.0. This API is experimental. Older incompatible CLIs report connection/run errors; Base URL remains available.

Each run uses an ephemeral thread, an isolated working directory, no execution environments, and the supplied document tools. The bridge restricts client RPC methods, disables web search/apps, and never approves other server requests. The child process stops on completion, cancellation, disconnect, or app exit. Codex's configured model provider receives the requested document context; running the CLI locally does not mean inference is offline.

### Base URL

Select **Base URL** for an OpenAI-compatible Chat Completions endpoint supporting tool calls. Set its URL, model, and session-only API key under **Connection settings**. URL/model/provider preferences are saved locally; the key is kept in memory and never saved to local storage. Model requests use the native Rust gateway. Stop immediately ignores late results; an already-sent HTTP request may finish at the provider.

Both providers use the same document tools and suggestion review workflow. Neither provider can accept/reject revisions or save the file. The browser preview can edit documents but cannot launch Codex or use the native model gateway.

### Agent validation

From the repository root:

```powershell
pnpm --filter superdoc-desktop typecheck
pnpm --filter superdoc-desktop test
pnpm --filter superdoc-desktop build:web
pnpm --filter superdoc-desktop test:layout
```

The deterministic suite tests proposal-only generation, exact selection targeting, ambiguous matches, revision checks, sequential approvals, cancellation, and Codex RPC lifecycle. Browser tests open real DOCX files, check layout at four widths, preserve a selection across focus changes, and exercise preview/application/export through a mocked gateway. CI does not require model credentials. To also exercise a real installed CLI using synthetic text only:

```powershell
$env:SUPERDOC_TEST_CODEX = 'C:/absolute/path/to/codex.exe'
$env:SUPERDOC_TEST_ACTION = 'academic' # Optional: real Academic action on a synthetic selection.
pnpm --filter superdoc-desktop exec vitest run src/agent/codex-live.test.ts
```

## Scope and release notes

The current implementation is a POC for local DOCX open/edit/save and a reviewable document Agent. File association, crash recovery, signed installers, automatic updates, Credential Manager integration, and a full external-file conflict UI remain release-hardening work. SuperDoc is AGPL-licensed in this repository; review the applicable licensing options before distributing a closed-source desktop product.
