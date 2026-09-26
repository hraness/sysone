# Contents

- `src/protocol.ts` owns the System One wire format: request/response schemas,
  body and field bounds, and the shared error envelope.
- `src/config.ts` owns the `~/.sys1/config.json` schema, defaults, load/save,
  and the settable-key registry. `SYS1_HOME` overrides the state directory.
- `src/router.ts` owns backend selection as a pure function over probed
  candidates — policy order, model pinning, capability limits, and exclusion
  of explicit-only candidates from unpinned fallback.
- `src/backends.ts` owns runtime backends: hosted Jev (credential from the
  environment only), configured HTTP services, installed builtin candidates,
  bounded probing (including advisory `GET /v1/limits`), and request
  forwarding.
- `src/defaults.ts` owns supported platform targets and experimental local
  setup choices: Qwen3 1.7B by default, or explicitly selected Qwen3 0.6B.
- `src/qualification.ts` owns bounded conformance checks for operator-configured
  System One HTTP backends.
- `src/local/decide.ts` owns bounded generic-GGUF prompts and the pure mapping
  from vocabulary probability mass to System One answers.
- `src/local/engine.ts` owns the lazy node-llama-cpp lifecycle and serialized
  first-token distribution evaluation.
- `src/local/store.ts` owns the curated model registry, the SHA-256-admitted
  GGUF store, manifest, download limits, structural validation, verification,
  and removal. Unsupported legacy inventories fail closed without mutation.
- `src/local/runner.ts` owns builtin candidate enumeration, configured local
  model selection, GGUF engine residency, and local response assembly.
- `src/gateway.ts` owns the loopback HTTP surface (`POST /v1/systemone`,
  `GET /v1/models`, `GET /healthz`), request validation, and the bounded
  retry loop.
- `src/daemon.ts` owns the pid file, detached spawn, health checks, and
  stop/status lifecycle.
- `src/doctor.ts` owns the stable versioned readiness report. Keep checks
  bounded, read-only, credential-free, and additive by id.
- `src/cli.ts` owns the `sys1` command surface and exit codes.
- `src/client.ts` is the portable Node/Bun client and `/client` export.
- `src/kev.ts` adapts explicit Kev endpoints, retaining two-decimal output and
  restoring Score legends only after validating their native rendering.
- `src/profile.ts` owns portable versioned decision profiles. Keep them pure:
  exact backend/model pin, frozen questions, state-only composition, no I/O.
- `src/runtime.ts` is the embedded Bun router with explicit disposal.
- `src/index.ts` is the runtime package public surface.
- `test/` contains protocol, routing, config, gateway, model-store, decision,
  and fake-engine tests; no ordinary test downloads weights, touches the
  network, or uses a real credential.
- `scripts/` holds the dist build, isolated exact-tarball package smoke,
  cross-platform release install verification, and `release-notes.ts`, which
  renders and verifies the GitHub Release page from `CHANGELOG.md`.
- `CHANGELOG.md` holds one section per version; the release workflow copies
  that section onto the release page and fails when it is missing.
- `site/` is the static sys1.io landing page; it has no product-runtime
  connection. `site/404.html` renders the shared design-kit status page;
  `scripts/build-site-status-page.ts --refresh` regenerates its markup,
  stylesheet, and `site/status-page.js` from one tagged design-kit release, and
  `test/site-status-page.test.ts` checks them against the recorded digests.
- `.github/workflows/check.yml` is read-only CI. `release.yml` is the annotated
  stable-tag channel for exact cross-platform artifacts and immutable GitHub
  Releases; it does not publish npm.
- `README.md`, `CONTRIBUTING.md`, `SECURITY.md`, and `LICENSE` are the public
  contract.

# Guidelines

- Use Bun 1.3.14. Run `bun run check` before handoff: strict typecheck,
  tests, dist build, and packed-package smoke check.
- Reject oversized local input without silently truncating evidence.
- Keep the gateway loopback-only. Config must reject non-loopback binding. Do
  not add remote state without an explicit authenticated design change.
- Read the hosted credential from the environment only. Never persist keys,
  log them, or put them in the config file, `--json` output, or error bodies.
- Never log request `state`, `questions`, or answer bodies; log routing
  metadata only. The GGUF worker uses private pipes, not request files.
- Parse every foreign value from `unknown` through the protocol schemas.
  Bound every input: body bytes, state bytes, question counts, options,
  timeouts, probes, and retry count.
- A backend that returned any HTTP response is definitive; only transport
  failures (no response) may re-dispatch, at most once, and never for a
  `backend/model` pinned request. Surface retries via `x-sys1-attempts`.
- Keep `--json` stable and machine-readable; additive fields only. Data to
  stdout, diagnostics to stderr, closed exit codes.
- Download weights only from explicit `sys1 setup` or `sys1 pull`; cap
  size, require a trusted SHA-256, stream to a temporary file, and admit only
  after digest, size, bounded GGUF header validation, safe filename, and
  regular-file checks. Never put weights in git, release artifacts, or ordinary CI.
- Treat generic-GGUF answers as an approximation, not calibrated Jev output.
  Disclose the adapter and quality signals via `x-sys1-local-*` headers.
  Keep Noul/Choice/Score answer
  objects exactly Jev-compatible. Do not make stronger model-quality claims
  without checkpoint-specific qualification.
- Apply Kev's rounding tolerance only to explicit Kev adapters or the paired
  gateway adapter/precision headers. Never renormalize lossy probabilities or
  treat profile IDs and model aliases as checkpoint attestation.
- Keep local inference lazy, serialized, cancellation-bounded, and
  residency-capped. Terminate and collect owned native worker processes on timeout, abort,
  eviction, and shutdown. Never claim unsupported native AbortSignal semantics.
- Only the installed model named by `local.model` receives unpinned local
  traffic. It defaults to Qwen3 1.7B. Every bundled Qwen model is experimental;
  Qwen3 0.6B and Qwen3.5 4B require explicit selection. Other installed models and configured HTTP services require a
  request pin. Never promote them when the selected model is missing.
- Honor published backend capability limits (`/v1/limits`) as advisory, and
  fail over-capability requests closed as `request_unsupported`.
- Keep operator-registered HTTP runners separately owned; never mutate their
  weights, credentials, or process lifecycle. Qualify discovery, limits, and
  response conformance without exposing request or response bodies.
- Fresh config is local-first: hosted Jev stays disabled even when its
  environment credential exists. Only `sys1 jev enable` activates it; the
  credential remains environment-only. Hosted Jev defaults to `jev-1.13.0`;
  enabling it selects `hosted-only`. Local fallback requires an explicit policy
  change after application-specific quality evaluation. Setup must preserve an
  existing hosted-only policy.
- Releases use one annotated `v<version>` tag at exact current `main`. Preserve
  exact tarball/checksum identity, Ubuntu/macOS/Windows artifact execution,
  repository release immutability, and the no-npm-publication boundary.
  Write the version's `CHANGELOG.md` section in the version bump pull request.
- Keep the public repository independently buildable. No sibling checkouts,
  private packages, internal project names, or unpublished provenance.

<!-- hraness-public-copy:start -->
- Public copy (websites, READMEs, docs, package and GitHub descriptions, CLI help, `llms.txt`, generated pages) follows `STYLE.md`, synced from hraness/.github. Text a model writes for publication also follows `GENERATION_STYLE.md`.
- The delivery vocabulary in this file (admission, qualification, custody, receipt, bounded, lane, gate, surface, projection) is internal. Translate it into what the reader gets.
- Take one-line product and sibling descriptions from the portfolio registry and versions from the release record. Tests pin facts, not prose.
- Run `bun run check:copy` before handoff when the repository has it.
<!-- hraness-public-copy:end -->

<!-- hraness-delivery:start -->
- Treat the user's request to change this repository as standing authorization for routine task-owned commits, pushes, pull requests, merges, releases, deployments, and production verification after the gates applicable to that action pass. Do not ask for duplicate confirmation. Build confidence through relevant automated checks, bounded diagnostics, and independent review, not another human approval. Passing checks does not expand task scope or authority.
- Prefer agentic service provisioning for new infrastructure. Check Vercel Marketplace for a native product that can provision the required resource first; use Stripe Projects as a supported alternative when it better covers the service or the Marketplace route only connects an existing account. Verify the current catalog, account, region, plan, recurring cost and resource capabilities before selecting a route. Prefer supported provider CLIs or APIs over browser-only setup when neither catalog fits, and explain the concrete exception. Reuse existing owner-controlled resources where appropriate; this preference alone does not authorize migrations, duplicate accounts, paid upgrades or wider access. Continue setup already authorized by the task and budget without duplicate confirmation. Keep provider credentials and generated environment files private, complete required interactive authentication, and verify deployment, persistence and recovery separately from successful provisioning.
- Separate artifact admission from live qualification and operational activation. Use applicable automated source, security, package/install, and provenance evidence for artifact admission; live provider qualification is not a universal publication prerequisite. Preserve explicit live acceptance criteria and require relevant live evidence for claims that depend on it. If publication or an artifact's install, upgrade, or default-use path activates risky unqualified behavior, keep that behavior guarded or disabled, or obtain bounded relevant evidence before shipping or activation.
- Use the repository's documented delivery workflow and preserve the identity, target, capacity, migration, and recovery guards applicable to operational activation. Replace an obsolete gate through a reviewed source and policy change with corresponding tests, never an ad hoc skip. Preserve every runtime-enforced approval, access control, branch protection, environment rule, safety policy, and required final gate. Ask for user input only when delivery needs a material product decision, missing credentials or authority, unavoidable interactive authentication, an irreversibly destructive action outside task scope, or resolution of a failure that cannot be handled safely and autonomously.
- Preserve production and user data throughout delivery. Inspect the exact account, environment, deployment, and data target before writes. For data changes, inspect a dry run or equivalent migration plan and validate the recovery path before any effect that could lose or corrupt data. Prefer additive, backward-compatible migrations and bounded batches. Record mutation intent, use idempotency or conditional writes, and reconcile uncertain results before retrying. Verify deployed identity, health, and relevant data invariants after delivery. Routine delivery never authorizes resetting, truncating, dropping, or overwriting user data; stop the unsafe operation if preservation or recovery cannot be established.
- Prefer short-lived repository workload identities such as OIDC trusted publishing, GitHub Apps, and narrowly scoped machine identities. Use unattended stable publication and production promotion when supported by the provider and repository. Establish supported machine authority once and verify it with a non-publishing preflight where available; routine releases should not require recurring interactive authentication or conversational approval. Releases and deployments run without a human in the loop: do not add required reviewers, manual approval environments, or wait timers to release or deployment paths, and remove any you find through a reviewed change. Keep account two-factor authentication, and do not add long-lived personal tokens.
- Main delivery is unattended. Open the pull request and enable auto-merge in the same breath (`gh pr merge --auto --squash <number>`), then move on; the required `Required` check is the reviewer. Until a repository's ruleset requires a check, `--auto` merges immediately, so wait for green checks there before merging. Never request a human reviewer or add required approvals, code owners, required conversation resolution, merge queues, manual-approval environments, or wait timers, and remove any you find with `scripts/apply-delivery-policy.py` from hraness/.github rather than by hand. Required checks run on the pull request head and are not re-required after main moves, so auto-merge never stalls behind another merge; main reruns the same gate after integration, and a red main is fixed forward by the next change. Repositories without CI use direct pushes to main.
- Preserve useful reasoning fan-out, but avoid unnecessary checkout fan-out. Prefer subagents in the current task for bounded research, review, diagnosis, and focused checks when they can safely share one working tree; create a separate task or worktree only for independently deliverable divergent edits, an isolated verification tree, or a different execution environment.
- Give each expensive focused validation command and external wait one owner. The integration owner reviews that evidence and runs the repository-required aggregate or final gate once after convergence. Reuse evidence only for the exact Git tree, command, lockfiles, toolchain, relevant environment, and validity period, and never to skip a required final integration, merge, release, deployment, or production-verification gate.
- On Hraness development machines, use the installed host scheduler for heavyweight top-level commands when available. Keep ordinary work in the compute lane; give authenticated browser/dev-server/Chromium work one `browser-auth` owner and Mac-only validation one `mac-native` owner.
- When a CI or policy gate scans complete Git history, check out the exact governed SHA and fetch only the fully qualified governed refs before scanning. Preserve the complete-history gate and reject unexpected refs instead of importing unrelated concurrent heads.
- At closeout, record applicable branch, PR, check, merge, release, deployment, and production evidence. Archive only conclusively finished tasks, never from silence alone, and reclaim only freshly revalidated clean merged worktrees through the guarded exact-path flow.
<!-- hraness-delivery:end -->

<!-- hraness-ci:start -->
- CI exists to admit a change in minutes, not to perform a ceremony. Every workflow declares `concurrency: { group: <name>-${{ github.ref }}, cancel-in-progress: true }` (release and deploy workflows set `cancel-in-progress: false`), a `timeout-minutes` on every job, and `permissions: contents: read` at the top with job-level widening only where needed.
- One job named `Required` closes every check workflow: `if: always()`, `needs:` every blocking job, and a single step that fails unless each `needs.<job>.result == 'success'`, or `skipped` because the change filter below reported its inputs unchanged. Branch policy requires only `Required` (plus a provider's own automated admission status when the product depends on it). Never make CodeQL, scheduled, or advisory jobs required.
- Cache by lockfile hash and restore before install: `Swatinem/rust-cache@v2` (with `save-if: ${{ github.ref == 'refs/heads/main' }}`) for Cargo, `oven-sh/setup-bun@v2` plus `actions/cache` on `~/.bun/install/cache` for Bun, `actions/setup-node` cache or `actions/cache` for npm/pnpm, `actions/setup-python` with `cache: pip` or `astral-sh/setup-uv` with cache for Python. Playwright browsers are cached under `~/.cache/ms-playwright` keyed by the Playwright version.
- Rust: install the pinned toolchain with `dtolnay/rust-toolchain` (`rustup toolchain install` at most once per job, `--profile minimal`), set `CARGO_INCREMENTAL: 0`, `CARGO_TERM_COLOR: always`, `CARGO_NET_RETRY: 10`, `RUSTFLAGS: -D warnings` and `RUST_BACKTRACE: short` at workflow level, use `cargo nextest` or one `cargo test --workspace --locked` after a shared `cargo build --all-targets --locked`, run `clippy` and `fmt` once on Linux only, install tools with `taiki-e/install-action` or `cargo-binstall` instead of `cargo install`, and build release binaries in one job whose artifact every later job reuses. Never build the same crate twice in one workflow.
- Run the matrix Linux-first. A macOS or Windows job exists only when the product ships a native surface for that OS, runs the OS-specific tests only, and is never the only place a generic check runs. Split long serial script lists into parallel jobs that share one build artifact instead of one job that runs for twenty minutes.
- Skip work that cannot change the result inside the workflow: a change-detection job runs `dorny/paths-filter@v4` (it needs job permission `pull-requests: read`, and `predicate-quantifier: some-with-excludes` needs v4), and jobs whose inputs did not change skip through job-level `if:`. Never put `paths`, `paths-ignore`, or `branches-ignore` on the `pull_request` trigger of the workflow that produces `Required`: a skipped workflow never reports `Required`, and the pull request can never merge. Every `uses:` pins a major tag or a SHA with a version comment, and Dependabot keeps `github-actions` current weekly with auto-merge.
- Measure before and after: a CI change records the previous and new median wall time of the slowest workflow in its pull request body. Regressions that add more than a minute to `Required` are reverted forward the same day.
<!-- hraness-ci:end -->

<!-- hraness-releases:start -->
- GitHub Release pages follow `RELEASES.md` in hraness/.github: the title is the registry product name and the tag, and the body is a summary, `## Changes`, `## Install`, `## Verify`, then the repository's identity record as a trailing HTML comment.
- The summary and changes come from the version's section of `CHANGELOG.md` in the tagged commit. Write that section in the version bump pull request. The release workflow copies it, generates Install and Verify from the release record, fails when the section is missing or empty, and never uses GitHub's generated notes.
<!-- hraness-releases:end -->
