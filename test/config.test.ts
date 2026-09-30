import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { readConfiguration, validateConfiguration } from "../src/config.ts";

const main = fileURLToPath(new URL("../src/main.ts", import.meta.url));

async function cli(args: string[]): Promise<{ code: number | null; output: string }> {
  const child = spawn(process.execPath, [main, ...args], { stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", data => { output += String(data); });
  child.stderr.on("data", data => { output += String(data); });
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", code => resolve({ code, output }));
  });
}

test("explicit host configuration validates and copies values", () => {
  const input = {
    model: "provider/model", thinking: "high", browser: "chromium", headless: true,
    tools: ["console", "wait"], http: ["GET"], network: "local", checkpoint: "private",
    durationMs: 600_000, deadlinePolicy: "pause", repeatDelayMs: 0, record: { intervalMs: 30_000, screenshots: true, events: ["tool", "thinking", "message"] },
    viewport: { width: 1280, height: 900 },
  };
  const actual = validateConfiguration(input);
  assert.deepEqual(actual, input);
  actual.tools?.push("save");
  assert.deepEqual(input.tools, ["console", "wait"]);
  actual.record?.events?.pop();
  assert.deepEqual(input.record.events, ["tool", "thinking", "message"]);
  assert.deepEqual(validateConfiguration({ record: { intervalMs: 30_000, events: [] } }).record, { intervalMs: 30_000, events: [] });
  assert.deepEqual(validateConfiguration({ record: { intervalMs: 30_000 } }).record, { intervalMs: 30_000 });
  assert.deepEqual(validateConfiguration({ tools: [], http: [], checkpoint: "none" }), { tools: [], http: [], checkpoint: "none" });
  assert.deepEqual(validateConfiguration({}), {}, "omitted deadline policy retains the default close behavior");
  assert.deepEqual(validateConfiguration({ deadlinePolicy: "close" }), { deadlinePolicy: "close" });
});

test("host configuration rejects unknown settings and invalid limits", () => {
  for (const input of [
    null, [], { typo: true }, { tools: ["bash"] }, { tools: ["console", "console"] },
    { http: ["TRACE"] }, { http: ["GET", "GET"] }, { http: "GET" },
    { network: "localhost" }, { checkpoint: "off" }, { headless: "true" },
    { browser: "safari" }, { model: "" }, { durationMs: 0 }, { durationMs: Infinity },
    { deadlinePolicy: "wait", durationMs: 1000 }, { deadlinePolicy: "pause" }, { deadlinePolicy: null },
    { repeatDelayMs: -1 }, { record: {} }, { record: { intervalMs: 0 } },
    { record: { intervalMs: 500, events: "tool" } }, { record: { intervalMs: 500, events: ["token"] } },
    { record: { intervalMs: 500, events: ["tool", "tool"] } }, { record: { intervalMs: 500, events: null } },
    { record: { intervalMs: 500, screenshots: "yes" } }, { record: { intervalMs: 500, path: "/tmp" } },
    { viewport: { width: 1280, height: 0 } }, { viewport: { width: 9000, height: 900 } },
    { viewport: { width: 1280, height: 900, zoom: 1 } },
  ]) assert.throws(() => validateConfiguration(input), JSON.stringify(input));
});

test("JSON configuration is explicit and never executes JavaScript", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pagent-config-"));
  try {
    const filename = path.join(root, "settings.json");
    await writeFile(filename, '{"network":"local","http":["GET"]}');
    assert.deepEqual(await readConfiguration(filename), { network: "local", http: ["GET"] });
    await writeFile(filename, "export default {}");
    await assert.rejects(readConfiguration(filename), /Cannot read configuration/);
    await assert.rejects(readConfiguration(path.join(root, "missing.json")), /Cannot read configuration/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("CLI capability flags fail before workspace creation; explicit flags override JSON", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pagent-config-cli-"));
  try {
    const directory = path.join(root, "untouched");
    const filename = path.join(root, "config.json");
    await writeFile(filename, JSON.stringify({ browser: "firefox", network: "local", http: ["GET"], durationMs: 20_000 }));
    for (const [args, expected] of [
      [["--tools", "bash"], /Tools must/],
      [["--http", "GET,TRACE"], /http must/],
      [["--duration=-1"], /durationMs must/],
      [["--deadline-policy", "wait"], /deadlinePolicy must/],
      [["--deadline-policy", "pause"], /pause requires durationMs/],
      [["--repeat-delay=-1"], /repeatDelayMs must/],
      [["--record", "0"], /record.intervalMs must/],
      [["--viewport", "banana"], /Viewport must/],
      [["--network", "internet"], /network must/],
      [["--checkpoint", "off"], /checkpoint must/],
    ] as const) {
      const run = await cli([directory, ...args]);
      assert.equal(run.code, 1, run.output);
      assert.match(run.output, expected);
    }
    const paused = await cli([directory, "--config", filename, "--deadline-policy", "pause", "--chromium", "/wrong"]);
    assert.equal(paused.code, 1);
    assert.match(paused.output, /Chromium-only/, "pause is accepted with JSON duration before unrelated browser validation");
    const overridden = await cli([directory, "--config", filename, "--browser", "chromium", "--firefox", "/wrong"]);
    assert.equal(overridden.code, 1);
    assert.match(overridden.output, /Use --browser firefox/);
    const configBrowser = await cli([directory, "--config", filename, "--chromium", "/wrong"]);
    assert.equal(configBrowser.code, 1);
    assert.match(configBrowser.output, /Chromium-only/);
    assert.deepEqual(await readdir(root), ["config.json"]);
    assert.equal(await readFile(filename, "utf8"), JSON.stringify({ browser: "firefox", network: "local", http: ["GET"], durationMs: 20_000 }));
  } finally { await rm(root, { recursive: true, force: true }); }
});
