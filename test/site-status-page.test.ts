import { expect, test } from "bun:test";
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { checkStatusPage, SYS1_STATUS_PAGE } from "../scripts/build-site-status-page.ts";

const root = resolve(import.meta.dir, "..");

test("the 404 page, stylesheet and bundle match the recorded design-kit release", async () => {
  await checkStatusPage(root);
  const manifest = JSON.parse(await readFile(join(root, "site/vendor/hraness-status-page/provenance.json"), "utf8"));
  expect(manifest.source.release).toBe("v0.21.0");
});

test("the 404 page keeps the site chrome around the shared status page", async () => {
  const html = await readFile(join(root, "site/404.html"), "utf8");
  expect(html).toContain('<meta name="robots" content="noindex" />');
  expect(html.match(/<header class="site-header hraness-marketing-header">/gu)).toHaveLength(1);
  expect(html.match(/<footer aria-label="Hraness network"/gu)).toHaveLength(1);
  expect(html).toContain('<main id="main" tabindex="-1">');
  expect(html).toContain('<div class="hraness-status-page" data-hraness-status-routes="');
  expect(html).toContain('href="/#install">Install Sys1</a>');
  expect(html).toContain('<link rel="stylesheet" href="/vendor/hraness-status-page/status-page.css" />');
  expect(html).toContain('<script src="/status-page.js" defer></script>');
  expect(html).not.toContain('rel="canonical"');
  expect(SYS1_STATUS_PAGE.next.length).toBeLessThanOrEqual(3);
  for (const link of SYS1_STATUS_PAGE.next) expect(link.description.length).toBeLessThanOrEqual(90);
});

test("check rejects an edited status page region", async () => {
  const copy = await mkdtemp(join(tmpdir(), "sys1-status-page-test-"));
  try {
    for (const path of ["site/404.html", "site/status-page.js", "scripts/site-status-page.js", "site/vendor/hraness-status-page"]) {
      await mkdir(join(copy, path, ".."), { recursive: true });
      await cp(join(root, path), join(copy, path), { recursive: true });
    }
    await checkStatusPage(copy);
    const html = await readFile(join(copy, "site/404.html"), "utf8");
    await writeFile(join(copy, "site/404.html"), html.replace("Install Sys1", "Install it"));
    await expect(checkStatusPage(copy)).rejects.toThrow("site/404.html");
  } finally {
    await rm(copy, { recursive: true, force: true });
  }
});
