import { readFile, readdir, mkdir, writeFile, rename } from "node:fs/promises";
import path from "node:path";
import type { Workspace } from "./storage.ts";
import { validateEntryDocument } from "./entry-document.ts";

/** Explicit recovery touches only the selected workspace, before its tab opens. */
export async function recoverWorkspace(workspace: Workspace, templateDir: string, options: {
  restore?: string; resetUI?: boolean; log: (message: string) => void;
}): Promise<void> {
  let recovery: string | undefined;
  if (options.restore) {
    const revisionsDir = path.join(workspace.stateDirectory, "revisions");
    const revision = options.restore === "latest" ? (await readdir(revisionsDir)).filter(name => name.endsWith(".html")).sort().at(-1) : options.restore;
    if (!revision || !/^[a-zA-Z0-9.-]+\.html$/.test(revision)) throw new Error("Specify a revision filename or 'latest'.");
    const html = await readFile(path.join(revisionsDir, revision));
    validateEntryDocument(html.toString());
    await workspace.write("/index.html", html);
    options.log(`Restored HTML checkpoint ${revision}. External resources are unchanged.`);
  }
  if (options.resetUI) {
    const backup = path.join(workspace.stateDirectory, "recovery", new Date().toISOString().replaceAll(":", "-"));
    recovery = backup;
    await mkdir(backup, { recursive: true });
    for (const entry of await readdir(templateDir, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const name = entry.name;
      try { await writeFile(path.join(backup, name), await workspace.read(`/${name}`)); }
      catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error; }
      await workspace.write(`/${name}`, await readFile(path.join(templateDir, name)));
    }
    options.log(`Restored starter UI. Previous files are backed up at ${backup}`);
  }
  if (options.restore || options.resetUI) {
    recovery ??= path.join(workspace.stateDirectory, "recovery", new Date().toISOString().replaceAll(":", "-"));
    await mkdir(recovery, { recursive: true });
    try { await rename(path.join(workspace.stateDirectory, "outbox.jsonl"), path.join(recovery, "outbox.jsonl")); }
    catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error; }
  }
}
