import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

const template = fileURLToPath(new URL("../template/", import.meta.url));
const runner = fileURLToPath(new URL("./fixtures/stdout-runner.ts", import.meta.url));
const diagnostic = `<script>
console.log('stdout startup log');
console.error('stdout console error');
setTimeout(() => { throw new Error('stdout uncaught error'); }, 50);
if (!document.documentElement.hasAttribute('data-stdout-submitted')) {
  const ready = setInterval(() => {
    if (!document.querySelector(\"#main\")?.canSubmit) return;
    clearInterval(ready);
    document.documentElement.setAttribute('data-stdout-submitted', 'yes');
    $(\"#main\").inputs[0].value = 'stdout fake model request';
    $(\"#main\").submit($(\"#main\").inputs[0].id);
  }, 25);
}
</script>`;

for (const browser of ["chromium", "firefox"]) {
  test(`${browser} stdout receives browser diagnostics and mirrored agent/tool output`, { timeout: 45_000 }, async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'pagent-stdout-'));
    const directory = path.join(root, 'stdout');
    await cp(template, directory, { recursive: true });
    const index = path.join(directory, 'index.html');
    await writeFile(index, (await readFile(index, 'utf8')).replace('</body>', diagnostic + '</body>'));
    const args = [runner, directory, browser];
    const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', data => { stdout += String(data); });
    child.stderr.on('data', data => { stderr += String(data); });
    const exited = new Promise<number | null>((resolve, reject) => { child.once('close', resolve); child.once('error', reject); });
    try {
      const deadline = Date.now() + 30_000;
      while (!stdout.includes('Pagent smoke complete.') && Date.now() < deadline && child.exitCode === null) await delay(25);
      assert.match(stdout, /\[browser console\.log\].*stdout startup log/);
      assert.match(stdout, /\[browser console\.error\].*stdout console error/);
      assert.match(stdout, /\[browser exception\.error\].*stdout uncaught error/);
      assert.match(stdout, /127\.0\.0\.1:\d+.*:\d+:\d+/);
      assert.match(stdout, /\[pagent user #.*stdout fake model request/);
      assert.match(stdout, /\[pagent reasoning #.*local scripted smoke test/);
      assert.match(stdout, /\[pagent tool console /);
      assert.match(stdout, /\[pagent tool result console /);
      assert.match(stdout, /\[pagent assistant #.*Pagent smoke complete\./, stderr + '\n' + stdout);
      // The completion occurs once: page logging never activates another model turn.
      assert.equal(stdout.split('] Pagent smoke complete.').length - 1, 1);
    } finally {
      child.kill('SIGTERM');
      const kill = setTimeout(() => child.kill('SIGKILL'), 10_000);
      try { assert.equal(await exited, 0, stderr); }
      finally { clearTimeout(kill); await rm(root, { recursive: true, force: true, maxRetries: 3 }); }
    }
  });
}
