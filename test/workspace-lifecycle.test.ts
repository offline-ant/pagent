import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { startPagent, type PagentApp, type PagentOptions } from "../src/app.ts";

for (const browser of ["chromium", "firefox"] as const) {
  test(`${browser} one host owns the directory until shutdown, then releases its listener and lock`, { timeout: 45_000 }, async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "pagent-directory-lifecycle-"));
    const options: PagentOptions = { directory, port: 0, headless: true, fake: true, browser,
      noSandbox: browser === "chromium" && process.env.PAGENT_TEST_NO_SANDBOX === "1" };
    let app: PagentApp | undefined;
    let unexpected: PagentApp | undefined;
    try {
      app = await startPagent(options);
      assert.equal(app.directory, directory);
      assert.equal(app.stateDirectory, path.join(directory, ".pagent"));
      const lock = path.join(app.stateDirectory, "host.lock");
      await access(lock);
      const original = await readFile(path.join(directory, "index.html"), "utf8");
      await assert.rejects(async () => { unexpected = await startPagent(options); }, /already open/i);
      assert.equal(await readFile(path.join(directory, "index.html"), "utf8"), original, "failed concurrent open never changes the live owner's resources");
      await app.browser.evaluateValue(`$('#main').inputs[0].value = 'Draft retained after clean shutdown'`);
      const url = app.url;
      const closing = app.close();
      await Promise.all([closing, app.close()]);
      await assert.rejects(access(lock), { code: "ENOENT" });
      await assert.rejects(fetch(url, { signal: AbortSignal.timeout(1000) }), "shutdown closes the resource listener");
      app = await startPagent(options);
      assert.equal(await app.browser.evaluateValue(`$('#main').inputs[0].value`), "Draft retained after clean shutdown");
      assert.equal(await app.browser.evaluateValue(`$('#main').canSubmit`), true);
      assert.equal(app.busy, false);
      await access(lock);
      await app.close();
      await assert.rejects(access(lock), { code: "ENOENT" });
    } finally {
      await unexpected?.close();
      await app?.close();
      await rm(directory, { recursive: true, force: true, maxRetries: 3 });
    }
  });
}
