import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const PACKAGE_ROOT = resolve(import.meta.dir, "..");
const PACKAGE_NAME = "@hraness/sys1";
const MAX_OUTPUT_BYTES = 4 * 1_024 * 1_024;

const REQUIRED = [
  "package/package.json",
  "package/dist/cli.js",
  "package/dist/index.js",
  "package/dist/index.d.ts",
  "package/dist/client.js",
  "package/dist/client.d.ts",
  "package/dist/engine-worker.js",
  "package/README.md",
  "package/LICENSE",
];

const FORBIDDEN_PREFIXES = [
  "package/src/",
  "package/test/",
  "package/scripts/",
  "package/site/",
  "package/docs/",
  "package/.github/",
  "package/node_modules/",
];

interface RunOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
}

async function readBounded(stream: ReadableStream<Uint8Array>, kill: () => void): Promise<string> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > MAX_OUTPUT_BYTES) {
        kill();
        throw new Error("package smoke command output exceeded 4 MiB");
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  return new TextDecoder().decode(Buffer.concat(chunks, bytes));
}

async function run(command: string[], options: RunOptions): Promise<string> {
  const child = Bun.spawn(command, {
    cwd: options.cwd,
    ...(options.env === undefined ? {} : { env: options.env }),
    stdout: "pipe",
    stderr: "pipe",
  });
  let timedOut = false;
  const kill = (): void => child.kill(9);
  const timer = setTimeout(() => {
    timedOut = true;
    kill();
  }, 120_000);
  try {
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      readBounded(child.stdout, kill),
      readBounded(child.stderr, kill),
    ]);
    if (timedOut) throw new Error(`command timed out: ${command.join(" ")}`);
    if (code !== 0) {
      throw new Error(`command failed (${code}): ${command.join(" ")}\n${stderr.slice(0, 2_000)}`);
    }
    return stdout;
  } finally {
    clearTimeout(timer);
  }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactDependencies(manifest: Record<string, unknown>): string[] {
  const dependencies = record(manifest["dependencies"], "dependencies");
  const names = Object.keys(dependencies).sort();
  if (names.length !== 1 || names[0] !== "zod") {
    throw new Error(`packed dependencies are unexpected: ${names.join(", ")}`);
  }
  const optional = record(manifest["optionalDependencies"], "optionalDependencies");
  if (Object.keys(optional).length !== 1 || optional["node-llama-cpp"] === undefined) {
    throw new Error("native runtime must be the only optional dependency");
  }
  for (const [name, version] of Object.entries({ ...dependencies, ...optional })) {
    if (typeof version !== "string" || !/^\d+\.\d+\.\d+$/.test(version)) {
      throw new Error(`dependency ${name} is not exactly pinned`);
    }
  }
  return [...names, ...Object.keys(optional)];
}

export async function packageSmoke(tarballArgument?: string): Promise<void> {
  const work = mkdtempSync(join(tmpdir(), "sys1-package-"));
  try {
    let tarball: string;
    if (tarballArgument === undefined) {
      const pack = Bun.spawn(
        ["npm", "pack", "--ignore-scripts", "--pack-destination", work],
        { cwd: PACKAGE_ROOT, stdout: "pipe", stderr: "pipe" },
      );
      const code = await pack.exited;
      if (code !== 0) {
        throw new Error(`npm pack exited ${code}: ${await new Response(pack.stderr).text()}`);
      }
      const filename = readdirSync(work).find((name) => name.endsWith(".tgz"));
      if (filename === undefined) throw new Error("npm pack produced no tarball");
      tarball = join(work, filename);
    } else {
      tarball = resolve(tarballArgument);
    }

    const listing = await run(["tar", "-tzf", tarball], { cwd: work });
    const entries = listing
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.endsWith("/"));
    const missing = REQUIRED.filter((path) => !entries.includes(path));
    if (missing.length > 0) throw new Error(`package is missing: ${missing.join(", ")}`);
    const forbidden = entries.filter((entry) =>
      FORBIDDEN_PREFIXES.some((prefix) => entry.startsWith(prefix)),
    );
    if (forbidden.length > 0) {
      throw new Error(`package leaks build inputs: ${forbidden.join(", ")}`);
    }

    const stage = join(work, "stage");
    const consumer = join(work, "consumer");
    mkdirSync(stage);
    mkdirSync(consumer);
    await run(["tar", "-xzf", tarball, "-C", stage], { cwd: work });
    const packedRoot = realpathSync(join(stage, "package"));
    const manifest = record(
      JSON.parse(readFileSync(join(packedRoot, "package.json"), "utf8")) as unknown,
      "package.json",
    );
    if (manifest["name"] !== PACKAGE_NAME) throw new Error("packed package name is wrong");
    if (manifest["license"] !== "MIT") throw new Error("packed package license is wrong");
    if (manifest["type"] !== "module") throw new Error("packed package must be ESM");
    if (typeof manifest["version"] !== "string") throw new Error("packed package version is missing");
    const repository = record(manifest["repository"], "repository");
    if (
      repository["type"] !== "git" ||
      repository["url"] !== "git+https://github.com/hraness/sys1.git"
    ) {
      throw new Error("packed repository identity is wrong");
    }
    const publish = record(manifest["publishConfig"], "publishConfig");
    if (
      publish["access"] !== "public" ||
      publish["provenance"] !== true ||
      publish["registry"] !== "https://registry.npmjs.org"
    ) {
      throw new Error("packed publish configuration is wrong");
    }
    const engines = record(manifest["engines"], "engines");
    if (Object.keys(engines).length !== 1 || engines["bun"] !== ">=1.3.14") {
      throw new Error("packed runtime engine boundary is wrong");
    }
    const trusted = manifest["trustedDependencies"];
    if (!Array.isArray(trusted) || trusted.length !== 1 || trusted[0] !== "node-llama-cpp") {
      throw new Error("packed native installer trust boundary is wrong");
    }
    const bin = record(manifest["bin"], "bin");
    if (Object.keys(bin).length !== 1 || bin["sys1"] !== "dist/cli.js") {
      throw new Error("packed bin must be exactly sys1 -> dist/cli.js");
    }
    const cli = readFileSync(join(packedRoot, "dist/cli.js"), "utf8");
    if (!cli.startsWith("#!/usr/bin/env bun\n")) throw new Error("packed CLI has the wrong shebang");
    const dependencies = exactDependencies(manifest);
    const exports = record(manifest["exports"], "exports");
    const clientExport = record(exports["./client"], "client export");
    if (clientExport["import"] !== "./dist/client.js" || clientExport["types"] !== "./dist/client.d.ts") {
      throw new Error("packed client subpath is invalid");
    }

    const modules = join(consumer, "node_modules");
    const packageTarget = join(modules, "@hraness", "sys1");
    mkdirSync(dirname(packageTarget), { recursive: true });
    renameSync(packedRoot, packageTarget);
    function linkDependency(dependency: string): void {
      const source = realpathSync(join(PACKAGE_ROOT, "node_modules", dependency));
      const destination = join(modules, dependency);
      mkdirSync(dirname(destination), { recursive: true });
      symlinkSync(source, destination, process.platform === "win32" ? "junction" : "dir");
    }
    // The portable client must work when the optional native runtime is absent.
    linkDependency("zod");
    writeFileSync(
      join(consumer, "package.json"),
      `${JSON.stringify({ private: true, type: "module" }, null, 2)}\n`,
    );
    writeFileSync(join(consumer, "client-smoke.mjs"), [
      `import { createClient, createProfile, Sys1ProfileError, Sys1ClientError } from "${PACKAGE_NAME}/client";`,
      `let calls = 0;`,
      `const client = createClient({ fetch: async (url, init) => {`,
      `  calls++;`,
      `  if (url !== "http://127.0.0.1:13900/v1/systemone" || init.redirect !== "error") throw new Error("unexpected client target");`,
      `  return Response.json({ model: "smoke", answers: { q: { type: "noul", noul: 0.5 } }, usage: { input_tokens: 1, output_tokens: 0 } });`,
      `} });`,
      `const profile = createProfile({ version: 1, id: "smoke", revision: "1", model: "fixture/smoke", questions: { q: { type: "noul" } } });`,
      `const result = await client.evaluate(profile.request("x"));`,
      `if (!Object.isFrozen(profile.definition.questions) || !(new Sys1ProfileError("invalid_profile") instanceof Error)) throw new Error("portable profiles failed");`,
      `if (result.response.answers.q.noul !== 0.5 || calls !== 1 || !(new Sys1ClientError("timeout") instanceof Error)) throw new Error("portable client failed");`,
      `console.log("portable client verified");`,
    ].join("\n"));
    writeFileSync(join(consumer, "worker-smoke.mjs"), [
      `import { spawn } from "node:child_process";`,
      `import { fileURLToPath } from "node:url";`,
      `const entry = fileURLToPath(new URL("./engine-worker.js", import.meta.resolve("${PACKAGE_NAME}")));`,
      `await new Promise((resolve, reject) => {`,
      `  const child = spawn(process.execPath, [entry], { stdio: ["pipe", "pipe", "ignore"], windowsHide: true });`,
      `  let wire = "", replied = false, failed = false;`,
      `  const fail = () => { failed = true; child.kill("SIGKILL"); child.stdin.destroy(); };`,
      `  const timer = setTimeout(fail, 5000);`,
      `  child.on("error", fail); child.stdin.on("error", fail); child.stdout.on("error", fail);`,
      `  child.stdout.on("data", (chunk) => {`,
      `    wire += chunk.toString("utf8");`,
      `    if (wire.length > 4096) return fail();`,
      `    if (!wire.endsWith("\\n")) return;`,
      `    try {`,
      `      const response = JSON.parse(wire);`,
      `      if (response.id !== 1 || response.kind !== "probe" || response.value.ok !== false) return fail();`,
      `      replied = true; child.stdin.end();`,
      `    } catch { fail(); }`,
      `  });`,
      `  child.once("close", (code) => { clearTimeout(timer); if (!failed && replied && code === 0) resolve(); else reject(new Error("packed worker protocol failed")); });`,
      `  child.stdin.write(JSON.stringify({ id: 1, op: "probe" }) + "\\n");`,
      `});`,
      `console.log("packed worker verified");`,
    ].join("\n"));
    for (const runtime of [process.execPath, "node"]) {
      const output = await run([runtime, join(consumer, "client-smoke.mjs")], { cwd: consumer });
      if (output.trim() !== "portable client verified") throw new Error("portable client returned invalid output");
      const workerOutput = await run([runtime, join(consumer, "worker-smoke.mjs")], { cwd: consumer });
      if (workerOutput.trim() !== "packed worker verified") throw new Error("packed worker returned invalid output");
    }
    writeFileSync(join(consumer, "client-types.ts"), [
      `import { createClient, createProfile, type DecisionProfile, type SystemOneRequest, type EvaluationResult } from "${PACKAGE_NAME}/client";`,
      `const request: SystemOneRequest = { state: "x", questions: { q: { type: "noul" } } };`,
      `const result: Promise<EvaluationResult> = createClient().evaluate(request);`,
      `void result;`,
      `const profile: DecisionProfile = createProfile({ version: 1, id: "test", revision: "1", model: "kev/kev-latest", questions: request.questions });`,
      `const fromProfile: SystemOneRequest = profile.request("x"); void fromProfile;`,
      `const question = profile.definition.questions["q"];`,
      `if (question?.type === "score") { const criterion = question.criteria[0]; void criterion; }`,
    ].join("\n"));
    writeFileSync(join(consumer, "tsconfig.json"), JSON.stringify({
      compilerOptions: { strict: true, noEmit: true, target: "ES2022", module: "NodeNext", types: [], lib: ["ES2022", "DOM"] },
      files: ["client-types.ts"],
    }));
    await run([process.execPath, join(PACKAGE_ROOT, "node_modules/typescript/bin/tsc"), "-p", consumer], { cwd: consumer });
    for (const dependency of dependencies.filter((name) => name !== "zod")) linkDependency(dependency);
    writeFileSync(
      join(consumer, "smoke.mjs"),
      [
        `import { DEFAULT_LOCAL_MODELS, DECISION_LABELS, isLoopbackHost, platformRecommendation, systemOneRequestSchema, systemOneResponseSchema } from "${PACKAGE_NAME}";`,
        `const parsed = systemOneRequestSchema.safeParse({ state: "x", questions: { q: { type: "noul" } } });`,
        `const response = systemOneResponseSchema.safeParse({ model: "smoke", answers: { q: { type: "noul", noul: 0.5 } }, usage: { input_tokens: 1, output_tokens: 0 } });`,
        `const recommendation = platformRecommendation({ platform: "linux", arch: "x64" });`,
        `if (!parsed.success || !response.success || !recommendation.supported || recommendation.model !== DEFAULT_LOCAL_MODELS.quality || DECISION_LABELS.length !== 35 || !isLoopbackHost("127.0.0.1"))`,
        `  throw new Error("packed public API failed");`,
        `console.log(JSON.stringify({ labels: DECISION_LABELS.length, loopback: true, model: recommendation.model }));`,
      ].join("\n"),
    );

    const home = join(consumer, "home");
    const env = { ...process.env, SYS1_HOME: home };
    const imported = JSON.parse(
      (await run([process.execPath, join(consumer, "smoke.mjs")], { cwd: consumer, env })).trim(),
    ) as unknown;
    if (record(imported, "public API output")["labels"] !== 35) {
      throw new Error("packed public API returned the wrong output");
    }
    const installedCli = join(packageTarget, "dist", "cli.js");
    const version = (await run([process.execPath, installedCli, "--version"], { cwd: consumer, env })).trim();
    if (version !== `sys1 ${String(manifest["version"])}`) {
      throw new Error(`packed CLI version ${version} does not match ${String(manifest["version"])}`);
    }
    const help = await run([process.execPath, installedCli, "--help"], { cwd: consumer, env });
    if (
      !help.startsWith("Usage: sys1 <command> [options]") ||
      !help.includes("sys1 setup [--dry-run]") ||
      !help.includes("sys1 jev status|enable|disable") ||
      !help.includes("sys1 doctor") ||
      !help.includes("sys1 pull [<model>]")
    ) {
      throw new Error("packed CLI help is incomplete");
    }
    const models = JSON.parse(
      (await run([process.execPath, installedCli, "model", "list", "--json"], { cwd: consumer, env })).trim(),
    ) as unknown;
    if (!Array.isArray(record(models, "model list")["data"])) {
      throw new Error("packed CLI model list returned invalid JSON");
    }
    const setup = record(
      JSON.parse(
        (await run(
          [process.execPath, installedCli, "setup", "--dry-run", "--tier", "compact", "--json"],
          { cwd: consumer, env },
        )).trim(),
      ) as unknown,
      "setup dry run",
    );
    if (
      setup["ok"] !== true ||
      record(setup["recommendation"], "setup recommendation")["model"] !== "qwen3-0.6b"
    ) {
      throw new Error("packed CLI setup defaults are invalid");
    }
    const jev = record(
      JSON.parse(
        (await run([process.execPath, installedCli, "jev", "status", "--json"], { cwd: consumer, env })).trim(),
      ) as unknown,
      "Jev status",
    );
    if (jev["enabled"] !== false || jev["active"] !== false) {
      throw new Error("packed CLI must keep Jev disabled by default");
    }
    console.log(`standalone package verified (${entries.length} files, Bun ${Bun.version})`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const [tarball, extra] = process.argv.slice(2);
  if (extra !== undefined) throw new Error("usage: package-smoke.ts [PACKAGE.tgz]");
  await packageSmoke(tarball);
}
