import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { detectBrowser } from "../src/browser-default.ts";

test("browser default prefers executable Firefox and otherwise selects Chromium", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pagent-browser-default-"));
  const environment = { PATH: process.env.PATH, FIREFOX_BINARY: process.env.FIREFOX_BINARY };
  try {
    process.env.PATH = root;
    delete process.env.FIREFOX_BINARY;
    assert.equal(await detectBrowser(), "chromium");
    await writeFile(path.join(root, "firefox"), "#!/bin/sh\nexit 1\n", { mode: 0o700 });
    assert.equal(await detectBrowser(), "firefox");
    process.env.FIREFOX_BINARY = path.join(root, "missing-firefox");
    assert.equal(await detectBrowser(), "chromium", "an explicit unavailable executable is not silently replaced");
    process.env.FIREFOX_BINARY = path.join(root, "firefox");
    process.env.PATH = "";
    assert.equal(await detectBrowser(), "firefox", "discovery shares launcher executable overrides");
  } finally {
    for (const [key, value] of Object.entries(environment)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  }
});
