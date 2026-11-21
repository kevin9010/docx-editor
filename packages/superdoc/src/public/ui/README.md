# Built-in UI controller conventions

## Names

- Name public types, methods, and events after the concept the developer uses: `ContextMenuConfig`, not
  `V2ContextMenuConfig`.
- Do not expose an implementation or version label unless developers must choose between distinct public contracts.

## Configuration and control

- Put automatic behavior in startup configuration under `ui.<surface>`.
- Put runtime control on `superdoc.ui.<surface>`.
- An openable surface exposes `open()` and `close()`. `open()` returns a fail-closed `WorkflowActionResult`; `close()` is
  safe to call when the surface is already closed or unavailable.
- Application-owned keyboard shortcuts call `open()`. Do not add a configuration option for each shortcut.

Keep each controller on the existing surface state. Do not introduce a second event bus or state store for the public
handle.

## Interface language

Set `ui.locale` to `'en'` (default) or `'zh-CN'` at startup. Read it with
`superdoc.ui.getLocale()` and change it with `superdoc.ui.setLocale(locale)`.
Language belongs to each instance. Changing it updates built-in interface labels
without remounting the document, altering content, or clearing history. Unknown
application labels keep their original text.
