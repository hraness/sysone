#!/usr/bin/env bun
import { readBoundedText } from "./http.ts";
import { existsSync } from "node:fs";
import {
  DEFAULT_CONFIG,
  SETTABLE_KEYS,
  configSchema,
  loadConfig,
  localBackendSchema,
  saveConfig,
  setConfigValue,
  sys1Home,
  type SettableKey,
  type Sys1Config,
} from "./config.ts";
import {
  clearPidFile,
  daemonDown,
  daemonStatus,
  daemonUp,
  healthz,
  gatewayUrl,
  readPidFile,
  writePidFile,
} from "./daemon.ts";
import { probeAll, runtimeBackends } from "./backends.ts";
import { DEFAULT_LOCAL_MODELS, LOCAL_MODEL_TIERS, platformRecommendation, type LocalModelTier } from "./defaults.ts";
import { runDoctor, type DoctorCheck } from "./doctor.ts";
import { bareScreen, commandHelp, rootHelp, SYS1_COMMANDS, SYS1_HELP_TOPICS } from "./cli-help.ts";
import { closestMatch, detectAudience, sym, type SymbolName } from "./cli-style.ts";
import { homedir } from "node:os";
import { SYS1_VERSION, startGateway } from "./gateway.ts";
import { probeNativeRuntime } from "./local/engine.ts";
import { qualifyBackend } from "./qualification.ts";
import { createProfile } from "./profile.ts";
import {
  MODEL_REGISTRY,
  installedModels,
  modelsDir,
  resolvePullTarget,
  pullModel,
  removeModel,
  storeBytes,
  verifyModel,
  type PullResult,
} from "./local/store.ts";

const EXIT = { ok: 0, usage: 2, config: 3, daemon: 4, backend: 5, doctor: 6 } as const;
const LOCAL_DECISION_NOTICE = "Local decisions are experimental. Check them on your own cases before acting on them: https://sys1.io/docs/evaluations";

function out(text: string): void {
  process.stdout.write(`${text}\n`);
}

function err(text: string): void {
  process.stderr.write(`${text}\n`);
}

/** The command being run, for error next steps. */
let currentCommand: string | undefined;
let jsonRequested = false;

const ERROR_CODES: Readonly<Record<number, string>> = { 1: "failed", 2: "usage", 3: "config", 4: "daemon", 5: "backend", 6: "doctor" };

function sentence(message: string): string {
  const text = message.trim().replace(/^usage: /u, "Usage: ");
  const capital = text.charAt(0).toUpperCase() + text.slice(1);
  return /[.!?`"]$/u.test(capital) ? capital : `${capital}.`;
}

function defaultNext(code: number): string {
  const command = currentCommand !== undefined && commandHelp(currentCommand) !== undefined ? currentCommand : undefined;
  if (code === EXIT.config) return "sys1 doctor";
  if (code === EXIT.daemon) return "sys1 status";
  if (code === EXIT.backend && command !== "backend" && command !== "pull" && command !== "model") return "sys1 doctor";
  return command === undefined ? "sys1 --help" : `sys1 ${command} --help`;
}

/** SPEC § D5: one sentence and one next command, or one JSON error object for agents and --json. */
function fail(message: string, code: number, next = defaultNext(code)): never {
  if (wantsJsonOutput()) {
    out(JSON.stringify({ ok: false, error: { code: ERROR_CODES[code] ?? "failed", message: sentence(message), next } }));
  } else {
    err(`${sym("fail", process.stderr)} ${sentence(message)}`);
    err(`${sym("next", process.stderr)} ${next}`);
  }
  process.exit(code);
}

// TODO(df-0.8): use detectAudience from @hraness/desktop-foundation.
function wantsJsonOutput(): boolean {
  return jsonRequested || detectAudience() === "agent";
}

function wantsJson(flags: Map<string, string | boolean>): boolean {
  return flags.get("json") === true || detectAudience() === "agent";
}

function isHuman(flags: Map<string, string | boolean>): boolean {
  return !wantsJson(flags) && detectAudience() === "human";
}

/** One `Next:` hint on stderr, for people only (SPEC § D7). */
function hint(flags: Map<string, string | boolean>, next: string): void {
  if (isHuman(flags)) err(`Next: ${next}`);
}

function tildePath(path: string): string {
  const home = homedir();
  return home !== "" && path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}


interface ParsedArgs {
  positional: string[];
  flags: Map<string, string | boolean>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = [];
  const flags = new Map<string, string | boolean>();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      if (eq > 0) {
        flags.set(arg.slice(2, eq), arg.slice(eq + 1));
      } else {
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith("--") && VALUE_FLAGS.has(arg)) {
          flags.set(arg.slice(2), next);
          i += 1;
        } else {
          flags.set(arg.slice(2), true);
        }
      }
    } else if (arg === "-h" || arg === "-V" || arg === "-v") {
      flags.set(arg === "-h" ? "help" : "version", true);
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

const VALUE_FLAGS = new Set([
  "--port",
  "--name",
  "--url",
  "--model",
  "--adapter",
  "--profile",
  "--size-b",
  "--cost-rank",
  "--tier",
  "--file",
  "--sha256",
]);

function flagNumber(flags: Map<string, string | boolean>, name: string): number | undefined {
  const raw = flags.get(name);
  if (raw === undefined || raw === true) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value)) fail(`--${name} needs a number, got ${raw}`, EXIT.usage);
  return value;
}

function flagString(flags: Map<string, string | boolean>, name: string): string | undefined {
  const raw = flags.get(name);
  return typeof raw === "string" ? raw : undefined;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KiB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GiB`;
}

function mustConfig(home: string): Sys1Config {
  const loaded = loadConfig(home);
  if (!loaded.ok) fail(loaded.message, EXIT.config);
  return loaded.config;
}

function setupTier(flags: Map<string, string | boolean>): LocalModelTier | undefined {
  const raw = flagString(flags, "tier");
  if (raw === undefined) return undefined;
  if (raw !== "compact" && raw !== "quality") {
    fail(`--tier must be ${LOCAL_MODEL_TIERS.join(" or ")}`, EXIT.usage);
  }
  return raw;
}

async function cmdSetup(home: string, flags: Map<string, string | boolean>): Promise<void> {
  const tier = setupTier(flags);
  const recommendation = platformRecommendation({
    ...(tier === undefined ? {} : { tier }),
  });
  if (!recommendation.supported || recommendation.model === null) {
    fail(recommendation.reason, EXIT.backend);
  }
  const model = recommendation.model;
  const download = {
    model,
    bytes: MODEL_REGISTRY.find((entry) => entry.id === model)?.bytes ?? null,
    directory: modelsDir(home),
    installed: isInstalled(home, model),
  };
  const downloadLine = download.installed
    ? `${model} is already installed in ${tildePath(download.directory)}.`
    : `${model}${download.bytes === null ? "" : ` (${formatBytes(download.bytes)})`} to ${tildePath(download.directory)}`;
  if (flags.get("dry-run") === true) {
    const report = { ok: true, dry_run: true, recommendation, download };
    if (wantsJson(flags)) out(JSON.stringify(report, null, 2));
    else {
      out(`Platform: ${recommendation.target} (${recommendation.acceleration})`);
      out(`Model: ${model} (${recommendation.tier}): ${recommendation.reason}`);
      out(download.installed ? downloadLine : `Would download ${downloadLine}.`);
      out(LOCAL_DECISION_NOTICE);
      hint(flags, "sys1 setup");
    }
    return;
  }

  if (!wantsJson(flags)) out(LOCAL_DECISION_NOTICE);
  const native = await probeNativeRuntime();
  if (!native.ok) fail(native.message ?? "local llama.cpp runtime is unavailable", EXIT.backend);
  const loaded = loadConfig(home);
  if (!loaded.ok) fail(loaded.message, EXIT.config);
  const config = structuredClone(loaded.config);
  config.local.enabled = true;
  config.local.model = recommendation.model;

  const existing = installedModels(home).find((model) => model.id === recommendation.model);
  let pull: PullResult | undefined;
  if (existing === undefined) {
    // Say how big the download is before the first byte (SPEC § D6).
    if (isHuman(flags)) err(`${sym("progress", process.stderr)} Downloading ${downloadLine}…`);
    const progress = downloadProgress(flags, recommendation.model);
    pull = await pullModel(home, recommendation.model, { onProgress: progress.update });
    progress.done();
    if (!pull.ok) {
      if (wantsJson(flags)) {
        out(JSON.stringify({ ok: false, recommendation, pull }, null, 2));
        process.exit(EXIT.backend);
      }
      fail(pull.message ?? "default model download failed", EXIT.backend, "sys1 setup");
    }
  }

  const path = saveConfig(home, config);
  const report = {
    ok: true,
    dry_run: false,
    recommendation,
    native: {
      backend: native.backend ?? "cpu",
      gpu_offloading: native.gpu_offloading ?? false,
    },
    config_path: path,
    model: {
      id: recommendation.model,
      already_installed: existing !== undefined,
      ...(existing === undefined ? { path: pull?.path, bytes: pull?.bytes } : { bytes: existing.bytes }),
    },
  };
  if (wantsJson(flags)) out(JSON.stringify(report, null, 2));
  else {
    out(`Platform: ${recommendation.target} (${native.backend ?? "cpu"})`);
    out(`${sym("ok", process.stdout)} Local setup complete: ${recommendation.model} is ${existing === undefined ? "installed" : "already installed"} and turned on.`);
    hint(flags, "sys1 up");
  }
}

/** Whether a model is installed; false when the store can't be read, so previews stay read-only. */
function isInstalled(home: string, model: string): boolean {
  try {
    return installedModels(home).some((installed) => installed.id === model);
  } catch {
    return false;
  }
}

/**
 * Download progress on a TTY stderr: one line redrawn in place at most once a
 * second, cleared when the download ends. Nothing for JSON, agents or pipes.
 */
function downloadProgress(flags: Map<string, string | boolean>, model: string): {
  update: (done: number, total: number | null) => void;
  done: () => void;
} {
  const live = isHuman(flags) && process.stderr.isTTY === true && process.env.TERM !== "dumb";
  let last = 0;
  let drawn = false;
  return {
    update: (done, total) => {
      if (!live || Date.now() - last < 1_000) return;
      last = Date.now();
      drawn = true;
      const suffix = total === null ? "" : ` / ${formatBytes(total)}`;
      process.stderr.write(`\r\x1b[K${sym("progress", process.stderr)} Downloading ${model}: ${formatBytes(done)}${suffix}`);
    },
    done: () => { if (drawn) process.stderr.write("\r\x1b[K"); },
  };
}

function cmdJev(home: string, args: ParsedArgs): void {
  const [sub] = args.positional.slice(1);
  const loaded = loadConfig(home);
  if (!loaded.ok) fail(loaded.message, EXIT.config);
  const credentialPresent = (process.env[loaded.config.hosted.api_key_env]?.length ?? 0) > 0;
  if (sub === "status") {
    const report = {
      enabled: loaded.config.hosted.enabled,
      credential_env: loaded.config.hosted.api_key_env,
      credential_present: credentialPresent,
      active: loaded.config.hosted.enabled && credentialPresent,
      model: loaded.config.hosted.model,
      base_url: loaded.config.hosted.base_url,
    };
    if (wantsJson(args.flags)) out(JSON.stringify(report, null, 2));
    else {
      out(`Jev: ${report.active ? "active" : report.enabled ? "enabled, credential missing" : "disabled"}`);
      out(`model: ${report.model}`);
      out(`credential: ${report.credential_env} (${credentialPresent ? "present" : "missing"})`);
    }
    return;
  }
  if (sub === "enable") {
    if (!credentialPresent) {
      fail(`set ${loaded.config.hosted.api_key_env} in the environment before enabling Jev`, EXIT.config);
    }
    const next = structuredClone(loaded.config);
    next.hosted.enabled = true;
    next.routing.policy = "hosted-only";
    const path = saveConfig(home, next);
    const report = { enabled: true, active: true, model: next.hosted.model, routing_policy: next.routing.policy, config_path: path };
    if (wantsJson(args.flags)) out(JSON.stringify(report, null, 2));
    else {
      out(`Jev enabled for ${next.hosted.model} (${path})`);
      out("routing is hosted-only; local fallback requires an explicit policy change after evaluation");
      out("restart the gateway if it was started before the credential was exported");
    }
    return;
  }
  if (sub === "disable") {
    const next = structuredClone(loaded.config);
    next.hosted.enabled = false;
    if (next.routing.policy === "hosted-only") next.routing.policy = "auto";
    const path = saveConfig(home, next);
    const report = { enabled: false, active: false, config_path: path };
    if (wantsJson(args.flags)) out(JSON.stringify(report, null, 2));
    else out(`Jev disabled (${path})`);
    return;
  }
  fail("usage: sys1 jev <status|enable|disable> [--json]", EXIT.usage);
}

async function cmdUp(home: string, flags: Map<string, string | boolean>): Promise<void> {
  const config = mustConfig(home);
  const port = flagNumber(flags, "port");
  if (port !== undefined) config.gateway.port = port;
  const cliEntry = process.argv[1];
  if (cliEntry === undefined) fail("cannot resolve cli entry", EXIT.daemon);
  const result = await daemonUp({ home, config, cliEntry, env: process.env });
  if (wantsJson(flags)) {
    out(JSON.stringify(result));
  } else if (result.ok) {
    out(`${sym("ok", process.stdout)} Gateway running at ${result.url} (pid ${result.pid}).`);
    hint(flags, "sys1 status");
  } else if (result.message.startsWith("already running")) {
    fail(`The gateway is ${result.message}; there is nothing to start.`, EXIT.daemon, "sys1 status");
  } else {
    fail(`The gateway didn't start: ${result.message.replaceAll("daemon", "gateway")}`, EXIT.daemon, "sys1 doctor");
  }
  if (!result.ok) process.exit(EXIT.daemon);
}

async function cmdDown(home: string, flags: Map<string, string | boolean>): Promise<void> {
  const config = mustConfig(home);
  const result = await daemonDown(home, config);
  if (wantsJson(flags)) {
    out(JSON.stringify(result));
  } else if (result.ok) {
    const text = result.message.replace(/^stopped daemon (\d+)$/u, "Stopped the gateway (pid $1).")
      .replace(/^not running/u, "The gateway isn't running");
    out(`${sym("ok", process.stdout)} ${sentence(text)}`);
  } else {
    fail(`The gateway didn't stop: ${result.message.replaceAll("daemon", "gateway")}`, EXIT.daemon, "sys1 status");
  }
  if (!result.ok) process.exit(EXIT.daemon);
}

async function cmdServe(
  home: string,
  flags: Map<string, string | boolean>,
): Promise<void> {
  const config = mustConfig(home);
  const port = flagNumber(flags, "port");
  const daemonChild = flags.get("daemon-child") === true;
  const instance = crypto.randomUUID();
  const gateway = startGateway({
    ...(daemonChild ? { daemon: { instance, onShutdown: () => shutdown() } } : {}),
    config,
    env: process.env,
    home,
    ...(port === undefined ? {} : { port }),
    reloadConfig: () => {
      const loaded = loadConfig(home);
      if (!loaded.ok) throw new Error(loaded.message);
      return loaded.config;
    },
  });
  if (daemonChild) {
    writePidFile(home, process.pid, config.gateway.host, gateway.port, instance);
  }
  err(`sys1 ${SYS1_VERSION} listening at ${gateway.url}`);
  let shuttingDown = false;
  const shutdown = (): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    void gateway
      .stop()
      .then(() => {
        if (daemonChild) clearPidFile(home, process.pid);
        process.exit(0);
      })
      .catch((error: unknown) => {
        err(`sys1: shutdown failed: ${error instanceof Error ? error.message : "unknown error"}`);
        process.exit(1);
      });
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  await new Promise(() => {});
}

async function cmdStatus(home: string, flags: Map<string, string | boolean>): Promise<void> {
  const config = mustConfig(home);
  const daemon = await daemonStatus(home, config);
  const backends = runtimeBackends(config, process.env, home);
  const probes = await probeAll(backends, config.gateway.probe_timeout_ms);
  const localModels = installedModels(home);
  const report = {
    daemon,
    gateway: { host: config.gateway.host, port: config.gateway.port },
    routing: { policy: config.routing.policy, local_model: config.local.model },
    local_store: { models: localModels.length, bytes: storeBytes(home) },
    backends: backends.map((backend) => ({
      name: backend.name,
      kind: backend.kind,
      available: backend.available,
      models: backend.models,
      size_b: backend.size_b,
      explicit_only: backend.explicitOnly === true,
      capabilities: backend.capabilities ?? null,
      probe: probes.get(backend.name)?.detail ?? null,
    })),
  };
  if (wantsJson(flags)) {
    out(JSON.stringify(report, null, 2));
    return;
  }
  out(daemon.state === "running"
    ? `${sym("on", process.stdout)} Gateway running at ${gatewayUrl(daemon.host, daemon.port)} (pid ${daemon.pid})`
    : `${sym("off", process.stdout)} Gateway ${daemon.state}`);
  out(`Routing: ${config.routing.policy} · local model ${config.local.model}`);
  out(`Local models: ${localModels.length} (${formatBytes(report.local_store.bytes)})`);
  if (report.backends.length > 0) out("Backends");
  for (const backend of report.backends) {
    const size = backend.size_b === null ? "" : ` ${backend.size_b}B`;
    const pin = backend.explicit_only ? ", only when a request names it" : "";
    out(`  ${sym(backend.available ? "on" : "off", process.stdout)} ${backend.name} (${backend.kind}${pin})${size}: ${backend.available ? "up" : "down"} · ${backend.models.join(", ")}`);
  }
  if (report.backends.length === 0) {
    out(`${sym("warn", process.stdout)} No backends are set up, so nothing can answer yet.`);
    out(`${sym("next", process.stdout)} sys1 setup`);
  } else if (daemon.state !== "running") {
    hint(flags, "sys1 up");
  }
}

async function cmdDoctor(home: string, flags: Map<string, string | boolean>): Promise<void> {
  const report = await runDoctor({ home, env: process.env });
  if (wantsJson(flags)) {
    out(JSON.stringify(report, null, 2));
  } else {
    out(renderChecks(report.checks, DOCTOR_NEXT));
  }
  if (!report.ok) process.exit(EXIT.doctor);
}

async function cmdModels(home: string, flags: Map<string, string | boolean>): Promise<void> {
  const config = mustConfig(home);
  const backends = runtimeBackends(config, process.env, home);
  await probeAll(backends, config.gateway.probe_timeout_ms);
  const rows = backends.flatMap((backend) =>
    backend.models.map((id) => ({
      id,
      backend: backend.name,
      kind: backend.kind,
      available: backend.available,
      size_b: backend.size_b,
    })),
  );
  if (wantsJson(flags)) {
    out(JSON.stringify({ object: "list", data: rows }, null, 2));
    return;
  }
  for (const row of rows) {
    out(`${row.id}\t${row.backend} (${row.kind}) ${row.available ? "up" : "down"}`);
  }
}

async function cmdPull(home: string, args: ParsedArgs): Promise<void> {
  if (args.flags.get("list") === true) {
    const rows = MODEL_REGISTRY.map((entry) => ({
      id: entry.id,
      kind: entry.kind,
      experimental: entry.experimental === true,
      size_b: entry.size_b,
      bytes: entry.bytes,
      description: entry.description,
      installed: installedModels(home).some((model) => model.id === entry.id),
    }));
    if (wantsJson(args.flags)) {
      out(JSON.stringify({ object: "list", data: rows }, null, 2));
      return;
    }
    for (const row of rows) {
      const tag = row.experimental ? `${row.kind},experimental` : row.kind;
      out(`${row.id}\t${tag}\t${formatBytes(row.bytes)}\t${row.installed ? "installed" : "available"}\t${row.description}`);
    }
    return;
  }

  const ref = args.positional[1] ?? DEFAULT_LOCAL_MODELS.quality;
  const sha256 = flagString(args.flags, "sha256");
  if (sha256 !== undefined && !/^[0-9a-f]{64}$/.test(sha256)) {
    fail("--sha256 needs 64 lowercase hexadecimal characters", EXIT.usage);
  }
  const asJson = wantsJson(args.flags);
  const known = MODEL_REGISTRY.find((entry) => entry.id === ref);
  if (isHuman(args.flags) && !("error" in resolvePullTarget(ref)) && !isInstalled(home, ref)) {
    err(`${sym("progress", process.stderr)} Downloading ${ref}${known === undefined ? "" : ` (${formatBytes(known.bytes)})`} to ${tildePath(modelsDir(home))}…`);
  }
  const progress = downloadProgress(args.flags, ref);
  const result = await pullModel(home, ref, {
    ...(sha256 === undefined ? {} : { sha256 }),
    onProgress: progress.update,
  });
  progress.done();
  if (asJson) {
    out(JSON.stringify(result, null, 2));
  } else if (result.ok) {
    out(`${sym("ok", process.stdout)} Installed ${result.id} (${formatBytes(result.bytes ?? 0)}) at ${tildePath(result.path ?? modelsDir(home))}.`);
  } else {
    fail(result.message ?? "model download failed", EXIT.backend, "sys1 pull --list");
  }
  if (!result.ok) process.exit(EXIT.backend);
}

async function cmdModel(home: string, args: ParsedArgs): Promise<void> {
  const [sub, id] = args.positional.slice(1);
  if (sub === "list") {
    const models = installedModels(home);
    if (wantsJson(args.flags)) {
      out(JSON.stringify({ object: "list", data: models, bytes: storeBytes(home) }, null, 2));
      return;
    }
    for (const model of models) {
      const size = model.size_b === undefined ? "unknown" : `${model.size_b}B`;
      out(`${model.id}\t${model.kind}\t${size}\t${formatBytes(model.bytes)}\t${model.source}`);
    }
    if (models.length === 0) out("no models installed; run `sys1 pull`");
    return;
  }
  if (sub === "verify") {
    if (id === undefined) fail("usage: sys1 model verify MODEL", EXIT.usage);
    const result = await verifyModel(home, id);
    if (wantsJson(args.flags)) {
      out(JSON.stringify({ id, ...result }, null, 2));
    } else {
      out(result.ok ? `${id}: verified` : `${id}: ${result.message ?? "sha256 mismatch"}`);
    }
    if (!result.ok) process.exit(EXIT.backend);
    return;
  }
  if (sub === "remove") {
    if (id === undefined) fail("usage: sys1 model remove MODEL", EXIT.usage);
    const result = removeModel(home, id);
    if (wantsJson(args.flags)) {
      out(JSON.stringify({ id, ...result }, null, 2));
    } else {
      out(result.message);
    }
    if (!result.ok) process.exit(EXIT.backend);
    return;
  }
  fail("usage: sys1 model <list|verify|remove> [MODEL]", EXIT.usage);
}

async function cmdEval(home: string, flags: Map<string, string | boolean>): Promise<void> {
  const config = mustConfig(home);
  const file = flagString(flags, "file");
  let raw: string;
  if (file === undefined || file === "-") {
    raw = await readBoundedText({ body: Bun.stdin.stream() }, 1_048_576);
  } else {
    if (!existsSync(file)) fail(`no such file: ${file}`, EXIT.usage);
    raw = await readBoundedText({ body: Bun.file(file).stream() }, 1_048_576);
  }
  const profileFile = flagString(flags, "profile");
  if (flags.has("profile") && profileFile === undefined) fail("--profile requires a file path", EXIT.usage);
  if (profileFile !== undefined) {
    try {
      const profileText = await readBoundedText({ body: Bun.file(profileFile).stream() }, 1_048_576);
      const profile = createProfile(JSON.parse(profileText) as unknown);
      const input: unknown = JSON.parse(raw);
      if (input === null || typeof input !== "object" || Array.isArray(input) ||
          Object.keys(input).length !== 1 || !Object.hasOwn(input, "state")) throw new Error();
      raw = JSON.stringify(profile.request((input as { state: unknown }).state));
    } catch {
      fail("invalid profile or input; --profile needs a valid profile file and JSON containing only state", EXIT.usage);
    }
  }
  const record = readPidFile(home);
  const host = record?.host ?? config.gateway.host;
  const port = record?.port ?? config.gateway.port;
  if (!(await healthz(host, port))) {
    fail(`gateway is not running at ${gatewayUrl(host, port)}; run \`sys1 up\``, EXIT.daemon);
  }
  let response: Response;
  try {
    response = await fetch(`${gatewayUrl(host, port)}/v1/systemone`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: raw,
      signal: AbortSignal.timeout(config.gateway.request_timeout_ms + 5_000),
      redirect: "error",
    });
  } catch (error) {
    fail(`gateway request failed: ${error instanceof Error ? error.message : "transport"}`, EXIT.backend);
  }
  const body = await readBoundedText(response, 4_194_304, AbortSignal.timeout(config.gateway.request_timeout_ms));
  out(body);
  if (!response.ok) process.exit(EXIT.backend);
}

function cmdConfig(home: string, args: ParsedArgs): void {
  const [sub, ...rest] = args.positional.slice(1);
  const loaded = loadConfig(home);
  if (!loaded.ok) fail(loaded.message, EXIT.config);
  switch (sub) {
    case "path": {
      out(loaded.path);
      return;
    }
    case "get": {
      out(JSON.stringify(loaded.config, null, 2));
      return;
    }
    case "set": {
      const [key, value] = rest;
      if (key === undefined || value === undefined) {
        fail("usage: sys1 config set <key> <value>", EXIT.usage);
      }
      if (!(key in SETTABLE_KEYS)) {
        const guess = closestMatch(key, Object.keys(SETTABLE_KEYS));
        fail(`Unknown setting "${key}".${guess === undefined ? " The settings you can change are listed in sys1 --help." : ` Did you mean "${guess}"?`}`, EXIT.usage);
      }
      const result = setConfigValue(loaded.config, key as SettableKey, value);
      if (!result.ok) fail(result.message, EXIT.usage);
      const path = saveConfig(home, result.config);
      out(`${key} = ${value} (${path})`);
      return;
    }
    case "unset": {
      const [key] = rest;
      if (key === undefined) fail("usage: sys1 config unset <key>", EXIT.usage);
      if (!(key in SETTABLE_KEYS)) {
        fail(`unknown key ${key}`, EXIT.usage);
      }
      const [section, field] = key.split(".") as [keyof Sys1Config, string];
      const defaults = DEFAULT_CONFIG[section] as Record<string, unknown>;
      const next = structuredClone(loaded.config);
      (next[section] as Record<string, unknown>)[field] = defaults[field];
      const path = saveConfig(home, configSchema.parse(next));
      out(`${key} reset to default (${path})`);
      return;
    }
    default:
      fail("usage: sys1 config <path|get|set|unset>", EXIT.usage);
  }
}

async function cmdBackend(home: string, args: ParsedArgs): Promise<void> {
  const [sub] = args.positional.slice(1);
  const loaded = loadConfig(home);
  if (!loaded.ok) fail(loaded.message, EXIT.config);
  switch (sub) {
    case "list": {
      const backends = loaded.config.backends;
      if (wantsJson(args.flags)) {
        out(JSON.stringify(backends, null, 2));
        return;
      }
      for (const backend of backends) {
        const size = backend.size_b === undefined ? "" : ` ${backend.size_b}B`;
        out(`${backend.name}${size} ${backend.enabled ? "" : "(disabled) "}→ ${backend.base_url} model ${backend.model}`);
      }
      if (backends.length === 0) {
        out("no HTTP backends configured; add one with `sys1 backend add`");
      }
      return;
    }
    case "add": {
      const name = flagString(args.flags, "name");
      const url = flagString(args.flags, "url");
      const model = flagString(args.flags, "model");
      if (name === undefined || url === undefined || model === undefined) {
        fail("usage: sys1 backend add --name N --url U --model M [--adapter systemone|kev] [--size-b N] [--cost-rank N]", EXIT.usage);
      }
      if (loaded.config.backends.some((candidate) => candidate.name === name)) {
        fail(`backend ${name} already exists`, EXIT.usage);
      }
      const size = flagNumber(args.flags, "size-b");
      const costRank = flagNumber(args.flags, "cost-rank");
      const adapter = flagString(args.flags, "adapter");
      if (args.flags.has("adapter") && adapter === undefined) fail("--adapter requires systemone or kev", EXIT.usage);
      const parsed = localBackendSchema.safeParse({
        name,
        base_url: url,
        model,
        ...(adapter === undefined ? {} : { adapter }),
        ...(size === undefined ? {} : { size_b: size }),
        ...(costRank === undefined ? {} : { cost_rank: costRank }),
        enabled: true,
      });
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        fail(`invalid backend: ${issue?.path.join(".") ?? ""} ${issue?.message ?? ""}`, EXIT.usage);
      }
      const next = structuredClone(loaded.config);
      next.backends.push(parsed.data);
      const path = saveConfig(home, next);
      out(`backend ${name} added (${path})`);
      return;
    }
    case "check": {
      const name = flagString(args.flags, "name");
      if (name === undefined) fail("usage: sys1 backend check --name N [--json]", EXIT.usage);
      const backend = loaded.config.backends.find((candidate) => candidate.name === name);
      if (backend === undefined) fail(`no backend named ${name}`, EXIT.usage);
      const report = await qualifyBackend(backend, {
        probeTimeoutMs: loaded.config.gateway.probe_timeout_ms,
        requestTimeoutMs: loaded.config.gateway.request_timeout_ms,
      });
      if (wantsJson(args.flags)) {
        out(JSON.stringify(report, null, 2));
      } else {
        out(renderChecks(report.checks, {}, `sys1 backend check --name ${backend.name} --json`));
      }
      if (!report.ok) process.exit(EXIT.backend);
      return;
    }
    case "remove": {
      const name = flagString(args.flags, "name");
      if (name === undefined) fail("usage: sys1 backend remove --name N", EXIT.usage);
      const next = structuredClone(loaded.config);
      const before = next.backends.length;
      next.backends = next.backends.filter((b) => b.name !== name);
      if (next.backends.length === before) fail(`no backend named ${name}`, EXIT.usage);
      const path = saveConfig(home, next);
      out(`backend ${name} removed (${path})`);
      return;
    }
    default:
      fail("usage: sys1 backend <list|add|check|remove>", EXIT.usage);
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const [command] = args.positional;
  const home = sys1Home(process.env);

  currentCommand = command;
  jsonRequested = args.flags.get("json") === true;
  if (args.flags.get("version") === true || (command === "version" && args.flags.get("help") !== true)) {
    if (jsonRequested) out(JSON.stringify({ name: "sys1", version: SYS1_VERSION }));
    else out(`sys1 ${SYS1_VERSION}`);
    return;
  }
  const wantsHelp = args.flags.get("help") === true;
  if (command === undefined && !wantsHelp) {
    process.stdout.write(bareScreen(SYS1_VERSION));
    return;
  }
  if (command === undefined || command === "help") {
    const topic = command === "help" ? args.positional[1] : undefined;
    if (topic === undefined) {
      process.stdout.write(rootHelp(Object.keys(SETTABLE_KEYS)));
      return;
    }
    const text = commandHelp(topic);
    if (text === undefined) {
      const guess = closestMatch(topic, SYS1_HELP_TOPICS);
      fail(`No help for "${topic}".${guess === undefined ? "" : ` Did you mean "${guess}"?`}`, EXIT.usage, "sys1 --help");
    }
    process.stdout.write(text);
    return;
  }
  if (wantsHelp) {
    const text = commandHelp(command);
    if (text === undefined) {
      const guess = closestMatch(command, SYS1_COMMANDS);
      fail(`Unknown command "${command}".${guess === undefined ? "" : ` Did you mean "${guess}"?`}`, EXIT.usage, "sys1 --help");
    }
    process.stdout.write(text);
    return;
  }

  switch (command) {
    case "setup":
      await cmdSetup(home, args.flags);
      return;
    case "jev":
      cmdJev(home, args);
      return;
    case "up":
      await cmdUp(home, args.flags);
      return;
    case "down":
      await cmdDown(home, args.flags);
      return;
    case "serve":
      await cmdServe(home, args.flags);
      return;
    case "status":
      await cmdStatus(home, args.flags);
      return;
    case "doctor":
      await cmdDoctor(home, args.flags);
      return;
    case "models":
      await cmdModels(home, args.flags);
      return;
    case "pull":
      await cmdPull(home, args);
      return;
    case "model":
      await cmdModel(home, args);
      return;
    case "eval":
      await cmdEval(home, args.flags);
      return;
    case "config":
      cmdConfig(home, args);
      return;
    case "backend":
      await cmdBackend(home, args);
      return;
    default: {
      const guess = closestMatch(command, SYS1_COMMANDS);
      fail(`Unknown command "${command}".${guess === undefined ? "" : ` Did you mean "${guess}"?`}`, EXIT.usage, "sys1 --help");
    }
  }
}

const DOCTOR_NEXT: Readonly<Record<string, string>> = {
  "runtime.bun": "bun upgrade",
  "state.directory": "sys1 config path",
  config: "sys1 config path",
  "native.runtime": "sys1 setup --dry-run",
  "models.manifest": "sys1 model list",
  "models.files": "sys1 pull",
  "models.inventory": "sys1 model list",
  "routing.candidates": "sys1 setup",
  daemon: "sys1 status",
};

const CHECK_SYMBOL: Readonly<Record<DoctorCheck["status"], SymbolName>> = { pass: "ok", warn: "warn", fail: "fail" };

/** SPEC § D7 check list: one symbol per check, a count, and one next step. */
function renderChecks(
  checks: readonly { id: string; status: DoctorCheck["status"]; summary: string }[],
  nextFor: Readonly<Record<string, string>>,
  fallbackNext = "sys1 doctor --json",
): string {
  const lines = checks.map((check) => {
    const summary = check.summary;
    return `${sym(CHECK_SYMBOL[check.status], process.stdout)} ${summary.charAt(0).toUpperCase()}${summary.slice(1)}`;
  });
  const failed = checks.filter((check) => check.status === "fail").length;
  const warned = checks.filter((check) => check.status === "warn").length;
  const parts = [failed === 0 ? "" : `${failed} problem${failed === 1 ? "" : "s"}`, warned === 0 ? "" : `${warned} warning${warned === 1 ? "" : "s"}`]
    .filter((part) => part !== "");
  lines.push("", parts.length === 0 ? `All ${checks.length} checks passed.` : `${parts.join(", ")}.`);
  const first = checks.find((check) => check.status === "fail") ?? checks.find((check) => check.status === "warn");
  if (first !== undefined) lines.push(`${sym("next", process.stdout)} ${nextFor[first.id] ?? fallbackNext}`);
  return lines.join("\n");
}

// A closed pipe (`sys1 --help | head -1`) is a normal way to stop reading.
process.stdout.on("error", (error: NodeJS.ErrnoException) => {
  if (error.code === "EPIPE") process.exit(0);
  throw error;
});

main().catch((error: unknown) => {
  fail(error instanceof Error ? error.message : "unexpected error", 1);
});
