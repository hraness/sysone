import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { SYS1_HELP_TOPICS } from "../src/cli-help.ts";
import { SYS1_VERSION } from "../src/gateway.ts";

const PROJECT_ROOT = fileURLToPath(new URL("..", import.meta.url));
const CLI = join(PROJECT_ROOT, "src", "cli.ts");
const homes: string[] = [];

function home(): string {
  const path = mkdtempSync(join(tmpdir(), "sys1-cli-ux-"));
  homes.push(path);
  return path;
}

afterEach(() => {
  for (const path of homes.splice(0)) rmSync(path, { recursive: true, force: true });
});

type Result = { code: number; stdout: string; stderr: string };
async function sys1(args: string[], env: Record<string, string> = {}): Promise<Result> {
  const child = Bun.spawn([process.execPath, CLI, ...args], {
    cwd: PROJECT_ROOT,
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: tmpdir(), LANG: "en_US.UTF-8", SYS1_HOME: home(),
      HRANESS_AUDIENCE: "human", ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { code, stdout, stderr };
}

const lines = (text: string) => text.trimEnd().split("\n");
const widest = (text: string) => Math.max(...lines(text).map((line) => line.length));

describe("sys1 help", () => {
  test("bare invocation is a short start screen", async () => {
    const result = await sys1([]);
    expect(result).toEqual({ code: 0, stderr: "", stdout: `Sys1 lets agents ask yes/no, choice, and score questions and get validated
answers with probabilities from hosted Jev, a local model, or your own server.

Start here
  sys1 setup --dry-run       See what setup would download
  sys1 setup                 Download the local model and turn it on
  sys1 up                    Start the gateway in the background
  echo '{…}' | sys1 eval     Ask a question through the gateway

Everyday
  sys1 status                Gateway state and which models can answer
  sys1 doctor                Check the install and say what to fix

All commands: sys1 --help · Command help: sys1 help <command>
sys1 ${SYS1_VERSION}
` });
    expect(lines(result.stdout).length).toBeLessThanOrEqual(25);
  });

  test("root help is grouped, at most 60 lines and 80 columns", async () => {
    for (const flag of ["--help", "-h", "help"]) {
      const result = await sys1([flag]);
      expect(result.code).toBe(0);
      expect(lines(result.stdout)[0]).toBe("Usage: sys1 <command> [options]");
      expect(result.stdout).toContain("Start here\n  sys1 setup [--dry-run]");
      expect(lines(result.stdout).length).toBeLessThanOrEqual(60);
      expect(widest(result.stdout)).toBeLessThanOrEqual(80);
    }
  });

  test("every command has help from <command> --help, -h and help <command>", async () => {
    for (const topic of SYS1_HELP_TOPICS) {
      const outputs = await Promise.all([[topic, "--help"], [topic, "-h"], ["help", topic]].map((args) => sys1(args)));
      for (const result of outputs) {
        expect(result.code).toBe(0);
        expect(result.stdout).toStartWith(`Usage: sys1 ${topic}`);
        expect(result.stdout).toBe(outputs[0]!.stdout);
      }
      expect(widest(outputs[0]!.stdout)).toBeLessThanOrEqual(80);
    }
  }, 120_000);

  test("--version prints the name and version", async () => {
    for (const flag of ["--version", "-V", "version"]) {
      expect((await sys1([flag])).stdout).toBe(`sys1 ${SYS1_VERSION}\n`);
    }
    expect(JSON.parse((await sys1(["--version", "--json"])).stdout)).toEqual({ name: "sys1", version: SYS1_VERSION });
  });

  test.skipIf(process.platform === "win32")("a closed pipe exits quietly", async () => {
    const child = Bun.spawn(["/bin/sh", "-c", `"${process.execPath}" "${CLI}" --help | head -1`], { stdout: "pipe", stderr: "pipe" });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({ code, stdout, stderr }).toEqual({ code: 0, stdout: "Usage: sys1 <command> [options]\n", stderr: "" });
  });
});

describe("sys1 setup preview", () => {
  test("dry-run says what would be downloaded, how big, and where", async () => {
    const result = await sys1(["setup", "--dry-run"], { SYS1_HOME: join(home(), "state") });
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/^Would download qwen3-1\.7b \(1\.03 GiB\) to \S+[\\/]state[\\/]models\.$/mu);
    expect(result.stderr).toBe("Next: sys1 setup\n");
    const json = JSON.parse((await sys1(["setup", "--dry-run", "--json"])).stdout);
    expect(json.download).toMatchObject({ model: "qwen3-1.7b", bytes: 1_107_409_472, installed: false });
    const quiet = await sys1(["setup", "--dry-run"], { HRANESS_AUDIENCE: "quiet" });
    expect(quiet.stderr).toBe("");
  });
});

describe("sys1 previews stay read-only", () => {
  test("setup --dry-run works when the model list is damaged", async () => {
    const state = home();
    mkdirSync(join(state, "models"), { recursive: true });
    writeFileSync(join(state, "models", "manifest.json"), "{not json");
    const result = await sys1(["setup", "--dry-run"], { SYS1_HOME: state });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Would download qwen3-1.7b (1.03 GiB)");
  });

  test("pull of an unknown model does not announce a download", async () => {
    const result = await sys1(["pull", "qwen3-7b"]);
    expect(result.code).toBe(5);
    expect(result.stderr).not.toContain("Downloading");
    expect(result.stderr).toStartWith("✗ ");
  });
});

describe("sys1 errors", () => {
  test("unknown commands are one line with a suggestion", async () => {
    expect(await sys1(["stauts"])).toEqual({ code: 2, stdout: "",
      stderr: '✗ Unknown command "stauts". Did you mean "status"?\n→ sys1 --help\n' });
    expect((await sys1(["config", "set", "routing.polcy", "auto"])).stderr)
      .toBe('✗ Unknown setting "routing.polcy". Did you mean "routing.policy"?\n→ sys1 config --help\n');
    expect((await sys1(["help", "doctr"])).stderr).toBe('✗ No help for "doctr". Did you mean "doctor"?\n→ sys1 --help\n');
  });

  test("--json and agents get one error object on stdout", async () => {
    const expected = { ok: false, error: { code: "usage", message: 'Unknown command "stauts". Did you mean "status"?', next: "sys1 --help" } };
    for (const [args, env] of [[["stauts", "--json"], {}], [["stauts"], { HRANESS_AUDIENCE: "agent" }]] as const) {
      const result = await sys1([...args], env);
      expect(result.code).toBe(2);
      expect(result.stderr).toBe("");
      expect(JSON.parse(result.stdout)).toEqual(expected);
    }
  });

  test("NO_COLOR, FORCE_COLOR and TERM=dumb", async () => {
    expect((await sys1(["stauts"], { NO_COLOR: "1" })).stderr).not.toContain("\x1b[");
    expect((await sys1(["stauts"], { FORCE_COLOR: "1" })).stderr).toStartWith("\x1b[31m✗\x1b[0m Unknown");
    expect((await sys1(["stauts"], { TERM: "dumb" })).stderr).toBe('FAIL Unknown command "stauts". Did you mean "status"?\n-> sys1 --help\n');
  });
});

describe("sys1 doctor", () => {
  test("uses plain words and symbols, then a count and one next step", async () => {
    const result = await sys1(["doctor"]);
    const out = lines(result.stdout);
    for (const line of out.slice(0, out.indexOf(""))) expect(line).toMatch(/^[✓⚠✗] [A-Z0-9]/u);
    expect(result.stdout).not.toMatch(/admitted|operator review|PASS|WARN/u);
    expect(result.stdout).toMatch(/\n\n(All \d+ checks passed\.|(\d+ problems?, )?\d+ warnings?\.|\d+ problems?\.)\n/u);
    const json = JSON.parse((await sys1(["doctor", "--json"])).stdout);
    expect(Array.isArray(json.checks)).toBe(true);
  }, 60_000);
});
