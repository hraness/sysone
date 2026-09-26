# Changelog

Each release page on GitHub copies its version's section from this file. Write
the section in the pull request that bumps the version: a one-line summary
paragraph, then one bullet per change a user or operator would notice. Keep
each paragraph and bullet on one line; release pages render line breaks.

## 0.11.0 - 2026-09-26

The sys1 command line is easier to read: a short start screen, help for every command, errors that say what to run next, and a setup that shows the download size first.

- Running `sys1` alone prints a short start screen. `sys1 --help` is grouped with a "Start here" block, and every command has its own help (`sys1 setup --help`, `sys1 help setup`).
- `sys1 setup --dry-run` and `sys1 setup` show the model, its size and the folder it downloads to before the first byte; `--json` adds a `download` object. Download progress redraws one line in a terminal and stays quiet in pipes.
- `sys1 doctor` prints one line per check with ✓, ⚠ or ✗, a count, and the command to run next. Check summaries use plain words; check ids and the JSON shape are unchanged.
- Errors are one sentence and one next command, such as `✗ Unknown command "stauts". Did you mean "status"?`, instead of the full usage. With `--json`, or when an agent runs sys1, they are one `{"ok":false,"error":{...}}` object on stdout. Exit codes are unchanged.
- When Claude Code, Codex, Cursor, Gemini CLI or `AI_AGENT` is detected, commands that support `--json` print JSON by default. `HRANESS_AUDIENCE=human` keeps text.
- `sys1 --version` and `-V` print `sys1 0.11.0`; `sys1 --version --json` prints the name and version.
- `sys1 status`, `up` and `down` print short sentences with ●/○ for the gateway state. Symbols fall back to ASCII with `TERM=dumb`, and `NO_COLOR` turns color off.

## 0.10.0 - 2026-09-21

Sys1 can send decisions to a Kev server you run, and versioned decision profiles let you reuse the same questions and instructions with hosted Jev, a local model, or Kev.

- `sys1 backend add --adapter kev` registers a Kev server. The gateway converts each request and response to and from Kev's format, keeps Kev's two-decimal probabilities without renormalizing them, and marks Kev answers with `x-sys1-adapter: kev` and `x-sys1-probability-decimals: 2`. Kev never receives unpinned traffic; a request reaches it only with a `backend/model` pin.
- `sys1 backend check` tests a Kev backend against Kev's decision format.
- `createProfile` (from `@hraness/sys1` and `@hraness/sys1/client`) builds a frozen, versioned profile with a pinned model and fixed questions. `profile.request(state)` returns an ordinary System One request.
- `sys1 eval --profile FILE` applies a saved profile to JSON input that contains only `{"state": ...}`. `examples/ticket-triage.profile.json` is a starting profile.
- The client accepts `adapter: "kev"` for calling a Kev endpoint directly, and reports Kev's precision in the response metadata.
