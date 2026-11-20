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

Installer builds make up to three attempts on the same runner, preserving Tauri's downloaded WiX/NSIS tools across temporary GitHub Releases download failures. A final build failure still fails the job and prevents artifact upload.

Download `superdoc-desktop-windows-<commit>` from the completed run's **Artifacts** section. It contains the `.msi`, `-setup.exe`, `-portable.zip`, and `.zip.sha256` deliverables. Extract the portable ZIP to run `SuperDoc-Desktop.exe`; the installers and portable build have the WebView2 and signing limitations described above.

To repeat artifact verification locally after packaging, run from the repository root:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File apps/desktop/scripts/verify-windows-artifacts.ps1
```

## Language and window menus

The desktop app starts in Simplified Chinese. Use **语言 / Language** to switch between Chinese and English; the preference is saved on this device. The Agent, progress messages, main editor toolbar, search, and review controls update without reloading the document or clearing edits, selection, or undo history. Document text, comments, and model suggestions keep their original language.

The native window title shows the document name and an asterisk for unsaved changes. **File / 文件** below the title bar contains Open, Save, Save As, Reload, and Auto-save; **View / 视图** toggles the Agent. Keyboard shortcuts are Ctrl+O, Ctrl+S, Ctrl+Shift+S, and Ctrl+Shift+R. The browser preview uses a compact equivalent menu. There is no separate large header above the editor.

## Opening documents

Use **File > Open / 文件 > 打开** to pick a `.docx` file with the system dialog, or drag a `.docx` file from Explorer onto the window. Both routes replace the current document and ask first when there are unsaved changes. The file is read on this machine; nothing leaves it until the Agent is used.

## Writing and reviewing

The SuperDoc toolbar stays inside the editor column and scrolls horizontally using its arrows, scrollbar, or mouse wheel. The rounded Agent card occupies the right column from toolbar level to the bottom, with its own scroll area and a matching shadow/background. Hiding it returns that space to the document.

Select a passage in SuperDoc to work on that passage, or choose **Whole document**. Choose **Revise**, **Polish**, **Proofread**, **Academic**, **Translate**, **Summarize**, or **Custom**, then set any instructions or output language. Choosing a function only selects it. Review the task, scope, and provider, then click **Confirm and generate suggestions** to start. The captured selection survives moving focus to the Agent. Translation requires a target language. Summarize returns a response without requesting a rewrite. **Custom** uses your free-form instructions and follows the same confirmation step.

**Confirm and generate suggestions** reads document context and creates editable suggestions alongside the original text. Every provider uses this review flow. Edit a replacement or comment directly, keep it unchanged, restore the Agent suggestion, or dismiss it. Draft edits stay outside the document. Applying uses exactly the text you reviewed; an empty replacement deletes the original passage, while empty comments and replacements identical to the original cannot be applied. Nothing is written by the model. **Apply as revision** creates a tracked replacement; **Add comment** creates a review comment. Use SuperDoc's own review controls to accept or reject changes. **Dismiss** leaves the document unchanged. Starting another run replaces the previous suggestion list.

Progress stays at the top while the settings and suggestions scroll independently. Both connection checks and runs show the current phase, elapsed time, and an activity log. Runs also show incoming response text and tool progress. After 20 seconds without new activity, the UI explicitly reports that it is waiting; this does not claim the model has failed. **Stop** cancels immediately and keeps received text and proposals available. Codex provider errors include their underlying `additionalDetails` and structured HTTP status, with separate explanations for account concurrency, authentication, and request/usage limits. Credential tokens and URL query strings are redacted. A run stops after five consecutive provider retries without model progress, two minutes of inactivity, or its total time limit; this does not change the user's global CLI retry configuration. The time limit and the API providers' turn budget scale with the text to read: five minutes and 8 turns for a selection or short document, growing to at most 15 minutes and 24 turns for long documents. When the turn budget runs out, the result says how many suggestions are ready. Model progress clears recovered diagnostics and resets consecutive retries. Reasoning events count as activity without displaying raw reasoning. The first generation checks the existing login but skips model discovery; the explicit connection check loads the model list and does not claim to have tested an actual inference request.

After a completed run, the Codex process stays connected so the next run skips start-up and the initialize handshake. It is closed after ten idle minutes, after a failed or stopped run, when the executable or provider changes, and when the app exits. Both API providers ask the endpoint to stream (`stream: true`), so response text appears as it is generated; a gateway that ignores streaming and returns one JSON body still works. The native client reuses one pooled HTTPS connection across turns and stops a reply that sends nothing for 90 seconds.

The app rejects stale document revisions and ambiguous whole-document matches. Selected-passage edits use the captured range, even if the same text occurs elsewhere. It limits a selected passage to 12,000 characters and a run to 16 suggestions; whole-document inspection is paginated. Applied Agent changes pause auto-save until the user explicitly saves; a suggestion that fails to apply without changing the document does not pause it. Edits made while a save is running keep the document marked unsaved and are saved next, and an auto-save that comes due during another operation waits for it instead of being dropped. Closing the window with unsaved changes asks for confirmation. A file moved or deleted outside the app is written again at its path on the next save. Auto-save waits 1.2 seconds after the last edit, longer for large files (up to 8 seconds above 20 MB), because each save exports the whole document. Documents travel between the webview and the native side as binary IPC payloads rather than JSON arrays, and file reads and writes run off the UI thread. Document replacement and saving are disabled during an Agent run or application.

### Local Codex CLI (default)

The app starts the already-installed `codex app-server --listen stdio://` and reuses its authentication and model configuration. It does not download or bundle Codex or read API keys from Codex's credential files. **Connection settings > Check connection** reports availability and loads the model list; **CLI default** preserves the CLI's configured model. If PATH discovery fails, specify an absolute installed `codex.exe` or npm `codex.cmd` path. npm shims are resolved to their native executable without invoking a shell. If signed out, run `codex login` separately and reconnect.

The bridge uses the [official Codex app-server protocol](https://developers.openai.com/codex/app-server). Dynamic document tools require an app-server version supporting `dynamicTools`, `item/tool/call`, and `environments: []`; the local integration test was validated with Codex 0.167.0. This API is experimental. Older incompatible CLIs report connection/run errors; the API providers remain available.

Each run uses an ephemeral thread, an isolated working directory, no execution environments, and the supplied document tools. The bridge restricts client RPC methods, disables web search/apps, and never approves other server requests. Each completed run releases its thread; the child process stays connected for the next run and stops after ten idle minutes, a failed or cancelled run, a disconnect, or app exit. A reused process still re-checks the login before each run. Codex's configured model provider receives the requested document context; running the CLI locally does not mean inference is offline.

### Local Claude Code CLI

Choose **Local Claude Code CLI** to use the native `claude` installation in your home `.local/bin` directory (`%USERPROFILE%\.local\bin\claude.exe` on Windows). Install and sign in using Claude Code's own installer and `claude auth login` before using it here. The app does not install Claude Code, read its credential files, or accept arbitrary executable paths. The optional model field accepts a CLI alias such as `opus` or `sonnet`, or a full supported model ID. An empty field uses the CLI default in safe mode.

**Check connection** checks the installed executable and local authentication status without sending document text or spending inference tokens. It does not prove that a provider will accept a generation request. The app inherits the desktop process environment (including supported Claude provider environment variables); it does not load project or user extensions/settings. Credentials configured only through a user's settings file must instead be available through the CLI login or the desktop process environment. Restart the desktop app after changing environment variables. No credentials are copied into app storage.

Generation starts a fresh non-interactive CLI process with `--safe-mode`, no built-in model tools, an empty strict MCP configuration, no Chrome integration or slash commands, and `--no-session-persistence`. Organization-managed policies can still apply: these flags are not an OS sandbox or a guarantee of zero filesystem writes. The document is passed as UTF-8 on stdin, not a command-line argument or temporary document file. The result must be a successful structured-output wrapper; plain text, malformed output, interrupted output, and CLI error results are not treated as successful suggestions. Older CLIs that do not support the safety flags must be updated; the app never silently retries with protections removed.

Claude Code returns a bounded batch of at most 16 suggestions rather than using Codex's live document-tool protocol. Exact text, unique whole-document matches, captured-selection scope, and current document revisions are rechecked through the same review layer. Suggestions remain editable and unapplied until the user approves them. Whole documents above 120,000 characters are rejected rather than silently truncated; select a passage (at most 12,000 characters) instead. If later suggestions fail validation, earlier pending suggestions remain available for review. The CLI response is shown after generation completes (not token-streamed); progress, elapsed time, Stop, and a 5–15-minute total limit remain available. Stop terminates the matching CLI child and ignores any late result, but does not guarantee the remote provider stops billing immediately.

### Optional API providers: OpenAI-compatible and Anthropic (Claude)

Two providers call a model endpoint directly through the native Rust gateway:

- **OpenAI-compatible API** sends Chat Completions requests (`/v1/chat/completions`) with tool calls. It works with OpenAI and gateways that accept that format. Sampling and token limits are left to the provider, because reasoning models reject a non-default temperature.
- **Anthropic (Claude) API** sends Messages API requests (`/v1/messages`, `anthropic-version: 2023-06-01`). It works with the Claude API and gateways that accept the same format, including custom model IDs such as a gateway's `…anthropic.claude-opus-5-5` name. **Key header** chooses `x-api-key` (the Claude API) or `Authorization: Bearer` (some gateways). The model's own thinking settings apply. Assistant turns, including `thinking` blocks and their signatures, are sent back unchanged on the next turn, as current Claude models require. A refusal (`stop_reason: "refusal"`) ends the run with the provider's explanation; no server-side fallback model is requested, because gateways may not accept that parameter.

Under **Connection settings**, enter the Base URL, the session-only API key, and the model ID. **Load models** lists the endpoint's models (`/v1/models`) without spending tokens, so it also checks the URL and key; gateways without a model list still work with a typed ID. A Base URL that is an origin or ends in `/v1` gets the standard path; a URL that already names the full endpoint is used as-is. HTTPS is required except for localhost.

Each provider keeps its own URL, model, and key, so switching providers never sends one provider's key to another endpoint. URLs, models, and the key header are saved locally; keys stay in memory and are never written to local storage, logs, or files. Error messages include the provider's explanation (for example an unknown model), with the key redacted if a gateway echoes it. **Stop** cancels the native request, which closes the connection so the provider stops generating.

All three providers use the same document tools and suggestion review workflow. None of them can accept/reject revisions or save the file. The browser preview can edit documents but cannot launch Codex or use the native model gateway.

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
