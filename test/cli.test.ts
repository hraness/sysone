import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, saveConfig, configSchema } from "../src/config.ts";
import { createFetchHandler } from "../src/gateway.ts";
import { LocalRunner } from "../src/local/runner.ts";
import { modelsDir, saveManifest } from "../src/local/store.ts";

const PROJECT_ROOT = fileURLToPath(new URL("..", import.meta.url));
const CLI = join(PROJECT_ROOT, "src", "cli.ts");
const homes: string[] = [];

function home(): string {
  const path = mkdtempSync(join(tmpdir(), "sys1-cli-test-"));
  homes.push(path);
  return path;
}

async function runCli(
  args: string[],
  options: { home: string; env?: Record<string, string> },
): Promise<{ code: number; stdout: string; stderr: string }> {
  const child = Bun.spawn([process.execPath, CLI, ...args], {
    cwd: PROJECT_ROOT,
    env: { ...process.env, HRANESS_AUDIENCE: "quiet", SYS1_HOME: options.home, ...options.env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, stdout, stderr };
}

afterEach(() => {
  while (homes.length > 0) {
    const path = homes.pop();
    if (path !== undefined) rmSync(path, { recursive: true, force: true });
  }
});

describe("setup CLI", () => {
  test("dry-run defaults to Qwen 1.7B and config can persist explicit selection", async () => {
    const dir = home();
    const result = await runCli(["setup", "--dry-run", "--json"], { home: dir });
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ recommendation: { model: "qwen3-1.7b", tier: "quality", experimental: true } });
    const selected = await runCli(["config", "set", "local.model", "qwen3-0.6b"], { home: dir });
    expect(selected.code).toBe(0);
    expect(loadConfig(dir)).toMatchObject({ ok: true, config: { local: { model: "qwen3-0.6b" } } });
  });

  test("dry-run reports an explicit compact recommendation without downloading", async () => {
    const dir = home();
    const result = await runCli(["setup", "--dry-run", "--tier", "compact", "--json"], {
      home: dir,
    });
    expect(result.code).toBe(0);
    const report = JSON.parse(result.stdout) as {
      ok: boolean;
      dry_run: boolean;
      recommendation: { model: string; tier: string; supported: boolean };
    };
    expect(report).toMatchObject({
      ok: true,
      dry_run: true,
      recommendation: { model: "qwen3-0.6b", tier: "compact", supported: true },
    });
    expect(loadConfig(dir)).toMatchObject({ ok: true, existed: false });
  });

  test("setup preview and registry label every bundled Qwen as experimental", async () => {
    const dir = home();
    const preview = await runCli(["setup", "--dry-run"], { home: dir });
    expect(preview.code).toBe(0);
    expect(preview.stdout).toContain("Local decisions are experimental");
    // The notice must send people to the page that publishes local Qwen results.
    expect(preview.stdout).toContain("https://sys1.io/docs/evaluations");
    const registry = await runCli(["pull", "--list", "--json"], { home: dir });
    expect(registry.code).toBe(0);
    const data = (JSON.parse(registry.stdout) as { data: { id: string; experimental: boolean }[] }).data;
    expect(data.filter((entry) => entry.id.startsWith("qwen")).map((entry) => [entry.id, entry.experimental])).toEqual([
      ["qwen3-0.6b", true], ["qwen3-1.7b", true], ["qwen3.5-4b", true],
    ]);
    expect(loadConfig(dir)).toMatchObject({ ok: true, existed: false });
  });
});

describe("Kev and profile CLI", () => {
  test("persists an explicit Kev adapter and rejects unknown adapters", async () => {
    const dir = home();
    const args = ["backend", "add", "--name", "kev", "--url", "http://127.0.0.1:8009", "--model", "kev-latest"];
    expect((await runCli([...args, "--adapter", "unknown"], { home: dir })).code).toBe(2);
    expect(loadConfig(dir)).toMatchObject({ ok: true, existed: false });
    expect((await runCli([...args, "--adapter", "kev"], { home: dir })).code).toBe(0);
    expect(loadConfig(dir)).toMatchObject({ ok: true, config: { backends: [expect.objectContaining({ adapter: "kev", model: "kev-latest" })] } });
  });

  test("a profile composes only the state and sends no profile metadata or overrides", async () => {
    const dir = home();
    const profile = { version: 1, id: "triage", revision: "v1", model: "kev/kev-latest", questions: { q: { type: "noul", instructions: "Is there a request?" } } };
    const profileFile = join(dir, "profile.json");
    const inputFile = join(dir, "input.json");
    writeFileSync(profileFile, JSON.stringify(profile));
    writeFileSync(inputFile, JSON.stringify({ state: "Please help" }));
    const received: unknown[] = [];
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
      if (new URL(request.url).pathname === "/healthz") return Response.json({ ok: true });
      received.push(await request.json());
      return Response.json({ model: "kev-latest", answers: { q: { type: "noul", noul: 0.9 } }, usage: { input_tokens: 10, output_tokens: 20 } });
    } });
    saveConfig(dir, configSchema.parse({ version: 1, gateway: { port: server.port } }));
    try {
      const args = ["eval", "--profile", profileFile, "--file", inputFile, "--json"];
      const result = await runCli(args, { home: dir });
      expect(result.code).toBe(0);
      expect(JSON.parse(result.stdout).model).toBe("kev-latest");
      expect(received).toEqual([{ model: profile.model, state: "Please help", questions: profile.questions }]);
      writeFileSync(inputFile, JSON.stringify({ state: "private input", model: "typesafe/jev-1.13.0" }));
      const overridden = await runCli(args, { home: dir });
      expect(overridden.code).toBe(2);
      expect(overridden.stderr).not.toContain("private input");
      expect(received).toHaveLength(1);
      writeFileSync(profileFile, JSON.stringify({ ...profile, model: "auto", secret: "private recipe" }));
      const invalid = await runCli(args, { home: dir });
      expect(invalid.code).toBe(2);
      expect(invalid.stderr).not.toContain("private recipe");
      expect(received).toHaveLength(1);
    } finally { server.stop(true); }
  });
});

describe("Jev CLI", () => {
  test("a credential does not activate Jev until explicitly enabled", async () => {
    const dir = home();
    const result = await runCli(["jev", "status", "--json"], {
      home: dir,
      env: { TYPESAFE_API_KEY: "super-secret" },
    });
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      enabled: false,
      credential_present: true,
      active: false,
    });
    expect(result.stdout).not.toContain("super-secret");
  });

  test("enable requires an environment credential and never persists it", async () => {
    const dir = home();
    const missing = await runCli(["jev", "enable"], { home: dir });
    expect(missing.code).toBe(3);
    expect(loadConfig(dir)).toMatchObject({ ok: true, existed: false });

    const enabled = await runCli(["jev", "enable", "--json"], {
      home: dir,
      env: { TYPESAFE_API_KEY: "super-secret" },
    });
    expect(enabled.code).toBe(0);
    expect(JSON.parse(enabled.stdout)).toMatchObject({ enabled: true, active: true, routing_policy: "hosted-only" });
    const loaded = loadConfig(dir);
    expect(loaded.ok).toBe(true);
    if (loaded.ok) {
      expect(loaded.config.hosted.enabled).toBe(true);
      expect(loaded.config.routing.policy).toBe("hosted-only");
      expect(JSON.stringify(loaded.config)).not.toContain("super-secret");
    }
    expect(`${enabled.stdout}${enabled.stderr}`).not.toContain("super-secret");
  });

  test("enabling Jev keeps an installed local model idle until fallback is explicitly selected", async () => {
    const dir = home();
    saveManifest(dir, { version: 1, models: [{
      id: "qwen3-1.7b", kind: "gguf", file: "qwen3-1.7b.gguf",
      source: "synthetic fixture", sha256: "0".repeat(64), bytes: 1,
      context: 2048, installed_at: "2026-01-01T00:00:00.000Z",
    }] });
    writeFileSync(join(modelsDir(dir), "qwen3-1.7b.gguf"), "x");
    const env = { TYPESAFE_API_KEY: "synthetic-credential" };
    expect((await runCli(["jev", "enable", "--json"], { home: dir, env })).code).toBe(0);

    let localCalls = 0;
    const runner = new LocalRunner({ home: dir, maxLoadedModels: 1, engineFactory: (model) => ({
      modelId: model.id,
      async firstTokenDistribution() {
        localCalls += 1;
        return { entries: [["yes", 1] as [string, number]], inputTokens: 1 };
      },
      async dispose() {},
    }) });
    const fetchFn = (async () => { throw new TypeError("synthetic hosted outage"); }) as unknown as typeof fetch;
    async function evaluateSavedPolicy(): Promise<Response> {
      const loaded = loadConfig(dir);
      if (!loaded.ok) throw new Error("fixture config is invalid");
      return createFetchHandler({ config: loaded.config, env, home: dir, localRunner: runner, fetchFn })(
        new Request("http://localhost/v1/systemone", {
          method: "POST", body: JSON.stringify({ state: "synthetic fixture", questions: { q: { type: "noul" } } }),
        }),
      );
    }
    try {
      expect((await evaluateSavedPolicy()).status).toBe(503);
      expect(localCalls).toBe(0);
      expect(runner.loadedModels()).toEqual([]);

      expect((await runCli(["config", "set", "routing.policy", "auto"], { home: dir })).code).toBe(0);
      expect((await evaluateSavedPolicy()).status).toBe(200);
      expect(localCalls).toBe(1);
    } finally {
      await runner.dispose();
    }
  });

  test("disable repairs hosted-only routing", async () => {
    const dir = home();
    saveConfig(
      dir,
      configSchema.parse({
        version: 1,
        hosted: { enabled: true },
        routing: { policy: "hosted-only" },
      }),
    );
    const disabled = await runCli(["jev", "disable", "--json"], { home: dir });
    expect(disabled.code).toBe(0);
    expect(JSON.parse(disabled.stdout)).toMatchObject({ enabled: false, active: false });
    const loaded = loadConfig(dir);
    expect(loaded.ok).toBe(true);
    if (loaded.ok) {
      expect(loaded.config.hosted.enabled).toBe(false);
      expect(loaded.config.routing.policy).toBe("auto");
    }
  });
});
