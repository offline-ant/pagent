import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { access, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

const main = fileURLToPath(new URL("../src/main.ts", import.meta.url));

function cli(args: string[], cwd?: string) {
  // A deliberately invalid key permits startup only. These tests never submit inference.
  const child = spawn(process.execPath, [main, ...args], { cwd,
    env: { ...process.env, PI_CODING_AGENT_DIR: path.join(cwd ?? tmpdir(), ".pagent-cli-auth"), OPENAI_API_KEY: "test-no-provider-requests", PI_OFFLINE: "1" },
    stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", chunk => { output += String(chunk); });
  child.stderr.on("data", chunk => { output += String(chunk); });
  const exited = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  return { child, exited, output: () => output };
}

async function waitFor(check: () => Promise<boolean> | boolean, output: () => string): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(10);
  }
  throw new Error(`Timed out waiting for CLI startup: ${output()}`);
}

async function stop(child: ChildProcess, exited: Promise<number | null>): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  const timeout = setTimeout(() => child.kill("SIGKILL"), 15_000);
  try { await exited; } finally { clearTimeout(timeout); }
}

test("CLI help describes directory operation without removed options", async () => {
  const run = cli(["--help"]);
  assert.equal(await run.exited, 0);
  assert.match(run.output(), /Usage: pagent \[directory\]/);
  assert.match(run.output(), /--reset-ui/);
  assert.match(run.output(), /installed Firefox, otherwise Chromium/);
  assert.doesNotMatch(run.output(), /--fake|--sessions|Fork\/New/);
});

for (const [args, message] of [
  [['--fake'], /Unknown option/],
  [['--sessions', '/tmp'], /Unknown option/],
  [['one', 'two'], /at most one directory/],
  [['--browser', 'safari'], /Unsupported browser/],
  [['--browser', 'firefox', '--no-sandbox'], /Chromium-only/],
  [['--browser', 'firefox', '--chromium', '/wrong'], /Chromium-only/],
  [['--browser', 'chromium', '--firefox', '/wrong'], /Use --browser firefox/],
  [['--port=-1'], /Port must be/],
] as const) {
  test(`CLI rejects invalid arguments: ${args.join(' ')}`, async () => {
    const run = cli([...args]);
    assert.equal(await run.exited, 1);
    assert.match(run.output(), message);
  });
}

test("existing non-agent HTML exits before display/authentication and changes no files", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pagent-cli-html-"));
  const html = "<!doctype html><title>Existing project</title><p>No agent here.</p>";
  await writeFile(path.join(root, "index.html"), html);
  try {
    const run = cli([], root);
    assert.equal(await run.exited, 1);
    assert.match(run.output(), /<p-agent>/);
    assert.doesNotMatch(run.output(), /graphical display|No credentials/);
    assert.deepEqual(await readdir(root), ["index.html"]);
    assert.equal(await readFile(path.join(root, "index.html"), "utf8"), html);
  } finally { await rm(root, { recursive: true, force: true }); }
});

for (const browser of ["chromium", "firefox"] as const) {
for (const early of [false, true]) {
  test(`${browser} directory CLI SIGTERM ${early ? "during startup" : "after startup"} cleans up owned resources`, { timeout: 35_000 }, async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pagent-cli-"));
    // Omit both directory and --port: exercise cwd and random-port defaults.
    const args = ["--browser", browser, "--model", "openai/gpt-5", "--headless"];
    if (browser === "chromium" && process.env.PAGENT_TEST_NO_SANDBOX === "1") args.push("--no-sandbox");
    const run = cli(args, root);
    const lock = path.join(root, ".pagent", "host.lock");
    try {
      if (early) await waitFor(async () => { try { await access(lock); return true; } catch { return false; } }, run.output);
      else await waitFor(() => run.output().includes("Pagent: http://"), run.output);
      await stop(run.child, run.exited);
      assert.equal(await run.exited, 0, run.output());
      await assert.rejects(access(lock), { code: "ENOENT" });
      if (!early) {
        assert.match(run.output(), /http:\/\/[^\s]+:\d+\//);
        assert.match(await readFile(path.join(root, "index.html"), "utf8"), /shadowrootserializable/);
      }
    } finally {
      await stop(run.child, run.exited);
      await rm(root, { recursive: true, force: true, maxRetries: 3 });
    }
  });
}
}
