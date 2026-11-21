# Desktop Agent boundaries

## Providers

The native desktop adapter keeps document editing in the SuperDoc worker and provider execution in Rust. Codex CLI and Claude Code CLI reuse independently installed programs and their authentication; neither CLI is bundled. Existing direct API providers remain optional for backward compatibility. There is no automatic provider/model fallback and no global CLI configuration is changed.

Codex exposes the two document tools through its app-server protocol. Claude Code runs one non-interactive generation with no model filesystem, shell, browser, or MCP tools and returns a structured batch. The frontend validates that batch and queues it using the same review tool dispatcher as Codex. Claude does not receive the document path. Context travels on stdin; output and execution duration are bounded. Whole-document requests over 120,000 characters and selections over 12,000 characters are rejected, not truncated.

## Trust and review

Document text is untrusted model input. Structured output is not permission to write: action names, string lengths, source containment, unique literal matches, selection identity and document revision are checked locally. All suggestions are pending until explicit user application. Application still requires an actual successful receipt and revision change, uses tracked replacements, and cannot accept/reject revisions or save the file automatically. Validation may preserve earlier pending suggestions if a later suggestion cannot be queued.

The native Claude bridge has no caller-selectable executable or command-line arguments. It uses the documented native home `.local/bin/claude` installation, fixed safety flags, and passes the optional model as a separate validated argument. User hooks, skills, plugins and workspace instructions are disabled with safe mode; organization-managed policy is preserved. This is a model-tool restriction, not an OS sandbox. The app never reads authentication files and does not expose raw CLI stdout/stderr errors or account metadata. CLI-managed credential refresh and organization-managed behavior are outside this adapter's storage guarantees.

A UUID identifies each native operation. Start registers its child before acknowledging, so a Stop during startup can cancel immediately after acknowledgement. Cancellation, timeout, window exit and normal completion reap the matching child. Settled frontend operations ignore duplicate or late channel messages. No session is resumed across document runs.

## Verification

- Unit tests exercise transport cancellation races, timeout, bounded structured output, selection/document limits, stale revisions, ambiguous matches, and proposal-only generation.
- Playwright opens a real DOCX and tests both CLI UI paths with deterministic transport mocks, including explicit confirmation, editing, manual tracked application, localization, and Stop. These tests do not prove real provider availability or native IPC execution.
- Optional live Codex testing uses only synthetic document text and the installed CLI. It verifies the app-server's resolved model during thread creation, but a successful local authentication or thread-start check alone is not inference verification.
- Claude Code model suggestions are documented aliases, not account discovery. The model field accepts a trimmed custom ID and passes it as one `--model` argument; an empty value omits the override. Connection checks only validate installation/login. Generation availability still depends on the installed CLI, provider catalog, account access, and organization policy. This checkout's Claude Code CLI was logged out during verification, so no real Claude inference was run.
- Native formatting, unit tests, Clippy and Windows packaging belong to the native build checks. The machine running them must have MSVC and the Windows SDK.

## Native startup

Windows creates one WebView2 environment using Microsoft's standard options and supplies it to the Tauri window builder. This avoids Wry's additional feature-disabling default arguments and keeps Evergreen's standard security, language, and profile behavior. The environment uses the existing application-local data directory; startup never deletes profiles, changes machine policy, or disables sandbox/integrity checks. The direct SDK dependencies reuse versions already in Cargo.lock.

Configured automatic window creation is disabled so startup can catch environment/window errors, distinguish the environment stage from later window initialization, record a bounded startup-only diagnostic, and show a native error dialog instead of an invisible release panic. This is not a diagnosis of every WebView2 failure and does not silently retry with weaker protections.

The fixed `--startup-smoke-test` flag suppresses only the modal error dialog and enables a constant stdout readiness marker. The main webview sends `startup_ready` after Vue mount/nextTick; this command takes no paths, text or credentials and cannot write files or launch programs. The test creates its own profile, waits for actual frontend/IPC readiness and a responsive window, rejects early exit, then closes only its own process. The same packaged executable must still be tested on the failing recipient machine. CLI authentication/inference is outside this startup check.

## Change history

### 2026-11-20 — Claude Code CLI provider

Added a second local CLI choice because the requested workflow only needs existing Codex and Claude Code installations. A one-shot structured batch avoids exposing a filesystem/MCP server to Claude or changing user CLI settings. Existing API modes are retained but are not required for the CLI workflow. The deliberate limits are fresh process startup per run, no token-streamed preview, a bounded document size, and external CLI/authentication prerequisites.
