import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

const execute = promisify(execFile);
const project = fileURLToPath(new URL("../", import.meta.url));

test("compiled npm artifact installs offline with scripts disabled and starts with its complete runtime", { timeout: 300_000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pagent-package-"));
  try {
    await execute("npm", ["run", "compile"], { cwd: project });
    const { stdout } = await execute("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", root], { cwd: project, maxBuffer: 8 * 1024 * 1024 });
    const packed = JSON.parse(stdout) as Array<{ filename: string; files: Array<{ path: string }> }>;
    assert.equal(packed.length, 1);
    const files = packed[0].files.map(file => file.path);
    assert(files.includes("dist/main.js"));
    assert(files.includes("template/index.html"));
    assert(files.includes("vendor/pi-browser-0.1.0.tgz"));
    assert(files.includes("node_modules/pi-browser/dist/core/index.js"));
    assert(files.includes("node_modules/@earendil-works/pi-coding-agent/node_modules/chalk/package.json"), "the shrinkwrapped SDK dependency tree must be complete");
    assert(!files.some(file => file.startsWith("sessions/") || file.startsWith("src/") || file.startsWith("test/")));
    const prefix = path.join(root, "install");
    await execute("npm", ["install", "--global", "--prefix", prefix, "--offline", "--ignore-scripts", "--no-audit", "--no-fund", path.join(root, packed[0].filename)], { cwd: root });
    const result = await execute(path.join(prefix, "bin", "pagent"), ["--help"], { cwd: root });
    assert.match(result.stdout, /Usage: pagent \[directory\]/);
    assert.doesNotMatch(result.stdout, /--fake|--sessions/);
    const installed = path.join(prefix, "lib", "node_modules", "pagent");
    const manifest = JSON.parse(await readFile(path.join(installed, "node_modules", "pi-browser", "package.json"), "utf8")) as { name: string };
    assert.equal(manifest.name, "pi-browser");
    assert.doesNotMatch(await readFile(path.join(installed, "dist", "main.js"), "utf8"), /from ["'][^"']+\.ts["']/);

    const directory = path.join(root, "workspace");
    await mkdir(directory);
    // Invalid test-only credentials allow startup, never a submitted model request.
    const child = spawn(path.join(prefix, "bin", "pagent"), ["./", "--headless", "--model", "openai/gpt-5"], {
      cwd: directory, stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, PI_CODING_AGENT_DIR: path.join(root, "credentials"), OPENAI_API_KEY: "test-no-provider-requests", PI_OFFLINE: "1" },
    });
    let output = "";
    child.stdout.on("data", chunk => { output += String(chunk); });
    child.stderr.on("data", chunk => { output += String(chunk); });
    const exited = new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    try {
      const deadline = Date.now() + 25_000;
      while (!output.includes("Pagent: http://") && child.exitCode === null && Date.now() < deadline) await delay(25);
      assert.match(output, /Pagent: http:\/\/127\.0\.0\.1:\d+\//);
      assert.match(await readFile(path.join(directory, "index.html"), "utf8"), /<p-agent/);
    } finally {
      child.kill("SIGTERM");
      const timeout = setTimeout(() => child.kill("SIGKILL"), 15_000);
      try { assert.equal(await exited, 0, output); }
      finally { clearTimeout(timeout); }
    }
    await assert.rejects(access(path.join(directory, ".pagent", "host.lock")), { code: "ENOENT" });
  } finally { await rm(root, { recursive: true, force: true }); }
});
