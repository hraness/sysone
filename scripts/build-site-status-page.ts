import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

// The 404 page renders the shared design-kit status page. Markup, stylesheet and
// browser enhancement all come from one immutable design-kit release: --refresh
// reads them from Git objects at the tagged commit, renders the markup into
// site/404.html between the markers, bundles the enhancement, and records every
// digest. --check (run by the tests) rejects any drift from that receipt.
const root = resolve(import.meta.dir, "..");
const vendor = "site/vendor/hraness-status-page";
const upstreamFiles = { "status-page.css": "src/status-page.css", LICENSE: "LICENSE" } as const;
const entry = "scripts/site-status-page.js";
const bundle = "site/status-page.js";
const page = "site/404.html";
const browser = "dist/browser/index.js";
const markup = "dist/index.js";
const manifestFile = `${vendor}/provenance.json`;
const START = "<!-- hraness-status-page:start -->";
const END = "<!-- hraness-status-page:end -->";

/** The page content. primaryAction matches the homepage hero's primary button. */
export const SYS1_STATUS_PAGE = {
  siteName: "Sys1",
  primaryAction: { href: "/#install", label: "Install Sys1" },
  next: [
    { href: "/docs", label: "Docs", description: "Install Sys1, pick hosted Jev or a local model, and call it from Node, Bun, or HTTP." },
    { href: "/compare", label: "Compare models", description: "JevBench scores, where each model runs, and what your workload would cost." },
    { href: "/docs/evaluations", label: "Evaluations", description: "Sys1’s own tests of each backend, wrong answers and raw reports included." },
  ],
  // Every page the site serves, for "Did you mean". They are never listed.
  routes: [
    { href: "/", label: "Sys1" },
    { href: "/docs", label: "Docs" },
    { href: "/docs/evaluations", label: "Evaluations" },
    { href: "/docs/evaluations-history", label: "Evaluation history" },
    { href: "/compare", label: "Compare models" },
    { href: "/compare-history", label: "Model comparison history" },
    { href: "/skills", label: "System One Skills" },
  ],
  agentIndexHref: "/llms.txt",
  rootElement: "div",
} as const;

const digest = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const receipt = (path: string, bytes: Uint8Array | string) => ({ path, sha256: digest(bytes), bytes: Buffer.byteLength(bytes) });
type Receipt = ReturnType<typeof receipt>;
interface Manifest {
  schemaVersion: 1;
  source: { repository: string; commit: string; release: string };
  files: Record<keyof typeof upstreamFiles, Receipt>;
  browser: Receipt;
  markupModule: Receipt;
  entry: Receipt;
  bundle: Receipt & { bunVersion: string };
  markup: Receipt;
}

function assertBytes(value: Uint8Array | string, expected: Receipt): void {
  if (Buffer.byteLength(value) !== expected.bytes || digest(value) !== expected.sha256) throw new Error(`Status page integrity mismatch: ${expected.path}`);
}
function git(repository: string, argv: string[]): Buffer {
  return execFileSync("git", ["-C", repository, ...argv], { maxBuffer: 16 * 1024 * 1024, timeout: 10_000 });
}
function region(html: string): string {
  const start = html.indexOf(START);
  const end = html.indexOf(END);
  if (start < 0 || end < start || html.indexOf(START, start + 1) >= 0) throw new Error(`${page} needs exactly one status page marker pair`);
  return html.slice(start + START.length, end);
}
function parseManifest(value: unknown): Manifest {
  const manifest = value as Manifest;
  if (manifest?.schemaVersion !== 1 || manifest.source?.repository !== "https://github.com/hraness/design-kit"
    || !/^[a-f0-9]{40}$/u.test(manifest.source.commit) || !/^v\d+\.\d+\.\d+$/u.test(manifest.source.release)
    || manifest.entry?.path !== entry || manifest.bundle?.path !== bundle || manifest.markup?.path !== page
    || Object.keys(manifest.files ?? {}).sort().join() !== Object.keys(upstreamFiles).sort().join()) {
    throw new Error("Invalid status page manifest; refresh from the immutable release first");
  }
  if (manifest.bundle.bunVersion !== "1.3.14") throw new Error("Unsupported status page build toolchain");
  return manifest;
}

async function build(sourcePath: string): Promise<Uint8Array> {
  if (Bun.version !== "1.3.14") throw new Error("Use Bun 1.3.14 for the status page bundle");
  const result = await Bun.build({
    entrypoints: [resolve(root, entry)], target: "browser", format: "iife", minify: true,
    plugins: [{ name: "pinned-status-page", setup(builder) {
      builder.onResolve({ filter: /^@hraness\/design-kit\/browser$/ }, () => ({ path: sourcePath }));
    } }],
  });
  if (!result.success || result.outputs.length !== 1) throw new Error(`Status page build failed: ${result.logs.join("\n")}`);
  return new Uint8Array(await result.outputs[0]!.arrayBuffer());
}

/** Read every input from one immutable Git object and publish outputs, receipt last. */
export async function refreshStatusPage(repository: string, commit: string, release: string): Promise<void> {
  if (!/^[a-f0-9]{40}$/u.test(commit) || !/^v\d+\.\d+\.\d+$/u.test(release)) throw new Error("Supply a full commit and stable release tag");
  if (git(repository, ["rev-parse", "--verify", `refs/tags/${release}^{commit}`]).toString().trim() !== commit) throw new Error("Release tag does not identify the supplied commit");
  const readGit = (path: string) => git(repository, ["show", "--no-textconv", `${commit}:${path}`]);
  const files = Object.fromEntries(Object.entries(upstreamFiles).map(([name, path]) => [name, readGit(path)])) as Record<keyof typeof upstreamFiles, Buffer>;
  const browserSource = readGit(browser);
  const markupSource = readGit(markup);
  // The bundler and the renderer load the checkout's files; they must be the tagged bytes.
  assertBytes(await readFile(resolve(repository, browser)), receipt(browser, browserSource));
  assertBytes(await readFile(resolve(repository, markup)), receipt(markup, markupSource));
  const { renderStatusPageHtml } = await import(pathToFileURL(resolve(repository, markup)).href) as {
    renderStatusPageHtml: (options: typeof SYS1_STATUS_PAGE) => string;
  };
  const rendered = renderStatusPageHtml(SYS1_STATUS_PAGE);
  const bootstrap = await readFile(resolve(root, entry));
  const output = await build(resolve(repository, browser));
  const html = await readFile(resolve(root, page), "utf8");
  const current = region(html);
  const updated = html.replace(`${START}${current}${END}`, () => `${START}${rendered}${END}`);
  const manifest: Manifest = {
    schemaVersion: 1,
    source: { repository: "https://github.com/hraness/design-kit", commit, release },
    files: Object.fromEntries(Object.entries(upstreamFiles).map(([name, path]) => [name, receipt(path, files[name as keyof typeof upstreamFiles])])) as Manifest["files"],
    browser: receipt(browser, browserSource),
    markupModule: receipt(markup, markupSource),
    entry: receipt(entry, bootstrap),
    bundle: { ...receipt(bundle, output), bunVersion: Bun.version },
    markup: receipt(page, rendered),
  };
  await mkdir(resolve(root, vendor), { recursive: true });
  for (const name of Object.keys(upstreamFiles) as (keyof typeof upstreamFiles)[]) await writeFile(resolve(root, vendor, name), files[name]);
  await writeFile(resolve(root, bundle), output);
  await writeFile(resolve(root, page), updated);
  await mkdir(dirname(resolve(root, manifestFile)), { recursive: true });
  await writeFile(resolve(root, manifestFile), `${JSON.stringify(manifest, null, 2)}\n`);
  await checkStatusPage(root);
}

export async function checkStatusPage(rootPath: string = root): Promise<void> {
  const manifest = parseManifest(JSON.parse(await readFile(resolve(rootPath, manifestFile), "utf8")));
  for (const name of Object.keys(upstreamFiles) as (keyof typeof upstreamFiles)[]) {
    assertBytes(await readFile(resolve(rootPath, vendor, name)), manifest.files[name]);
  }
  assertBytes(await readFile(resolve(rootPath, entry)), manifest.entry);
  assertBytes(await readFile(resolve(rootPath, bundle)), manifest.bundle);
  assertBytes(region(await readFile(resolve(rootPath, page), "utf8")), manifest.markup);
}

if (import.meta.main) {
  const [operation, repository, commit, release, ...extra] = process.argv.slice(2);
  if (operation === "--refresh" && repository && commit && release && extra.length === 0) await refreshStatusPage(resolve(repository), commit, release);
  else if (operation === "--check" && repository === undefined) await checkStatusPage(root);
  else throw new Error("Usage: bun scripts/build-site-status-page.ts --refresh KIT_CHECKOUT FULL_COMMIT vVERSION | --check");
  console.log("Shared status page assets verified");
}
