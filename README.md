# pagent

Pi agents whose workspace and user interface are one live browser page, backed by
an ordinary directory. The page owns its editors, conversation records, tool
display, working memory, and interaction policy. Agents can edit those files and
the live DOM.

Pagent is a standalone Node **24+** CLI, not a Pi extension. It uses Pi **0.87.0**
and the bundled `pi-browser` library for Firefox/WebDriver BiDi and Chromium/CDP.
No sibling checkout or `pi-ant` package is required at runtime.

## Install and run

Install a compiled package artifact:

```sh
npm install --global --ignore-scripts ./pagent-0.1.0.tgz

# Authenticate and choose a default model once in Pi.
pi
# /login
# /model, then Ctrl+S to save the default

# Open the current directory, or choose another directory.
pagent ./
pagent /path/to/project
```

With no directory argument, Pagent uses the current directory. It opens
`index.html` in a dedicated, controlled browser window at
`http://127.0.0.1:<random-port>/`. It prefers installed **Firefox**, otherwise
**Chromium**. A graphical display and a current browser supporting serializable
shadow DOM are required for normal use. It does not reuse your everyday browser
profile. **Use the window it opens:** manually opening the URL produces a page
without the native agent connection.

- If `index.html` is missing, Pagent creates the starter HTML and required UI
  files. A collision with any starter filename is an error; existing files are
  never overwritten implicitly.
- Existing HTML must contain a real, static, light-DOM HTML `<p-agent>` element.
  Comments, script strings, template contents, and foreign elements do not count.
  Without one, Pagent prints a warning and exits nonzero before creating private
  state, resolving authentication, or launching the browser. It does not execute
  page scripts to discover agents.
- Existing documents and their resources are used as-is. A `<p-agent>` alone
  does not implement the UI: the document must also load scripts implementing
  the page-native protocol described below.
- Each invocation owns one directory, one controlled page, one browser process,
  and one loopback HTTP listener. Opening an already-locked directory is rejected.

```sh
pagent                         # Current directory; Pi's saved default model
pagent ./notes --browser chromium
pagent ./notes --model openai-codex/gpt-5.4 --thinking high
pagent ./notes --port 8080
pagent ./notes --browser firefox --firefox /path/to/firefox
pagent ./notes --headless       # Explicit automation mode
pagent --help
```

The default model/provider and thinking preferences come from Pi's **global**
settings. If no default model is saved, Pagent uses `gpt-6-astra`, resolved through
Pi's authenticated providers. `--model` and `--thinking` override these defaults.
Ambiguous provider selection requires `--model provider/model`. Missing credentials
direct you to Pi's `/login`; expired OAuth tokens also require a new login, not a
page reload. Model definitions and credentials stay host-side. Pagent does not
load directory-local Pi settings, extensions, skills, or context files such as
`AGENTS.md`. There is no public fake-model mode; faux inference is test-only.

Ctrl+C or SIGTERM cancels work, checkpoints the page, closes the owned browser
and listener, and releases the lock. Save before manually closing the browser
page: once closed, its unsaved DOM cannot be captured. Restarting the directory
loads its saved scripts and conversation without resubmitting old prompts.
Switch browsers by stopping the host and restarting with `--browser`; HTML and
resources remain shared, while engine profiles are separate.

## Directory ownership

```text
project/                       The directory passed to pagent; public resource root
  index.html                   Saved page, conversation, and drafts
  agent.css                    Minimal starter styles
  agent.js                     Custom-element registration and context selection
  p-agent.js                   Agent element and run lifecycle
  user-input.js                Editable input and submission
  agent-connection.js          Native connection, routing, and replay cursor
  agent-controls.js            Agent and page controls
  agent-output.js              Output rendering and paragraph timestamps
  dom.js                       Shared DOM helpers
  paragraphs.js                Completed-paragraph detection
  notes/                       Ordinary agent-created resources
  .pagent/                     Private host state; never HTTP-served
    host.lock                  Exclusive directory owner
    firefox/                   Dedicated workspace browser profile
    chromium/                  Separate Chromium profile
    outbox.jsonl               Uncheckpointed events, not model history
    web-backend.json            Persisted research backend override
    research/<sha256-id>/       Per-agent research profiles
    web-snapshots/<sha256-id>/  Per-agent immutable web evidence
    revisions/                 HTML checkpoints
    recovery/                  Explicit recovery backups
```

Add `.pagent/` to your project's ignore rules if using version control. The
editable HTML, JavaScript, CSS, and other public resources are your project
files; updating the installed CLI does not replace them. Template files are
copied only when seeding a missing entry document or explicitly resetting the UI.

Programmatic hosts call `startPagent({ directory?: string, ... })`. The returned
app exposes `directory`, `stateDirectory`, `url`, `browser`, `agents` (a read-only
map of engines), `modelLabel`, `busy`, `getBackendState()`, `save()`, `flush()`,
and `close()`. `close()` checkpoints and shuts down the host.

## Agents and runs

The starter's `<p-agent id="main">` is an ordinary agent, not a privileged parent.
Full `<p-agent>` elements can appear anywhere in light DOM, including ordinary
containers and nested agents. Agents share model settings, DOM/runtime, and
resource files, but have independent inference and scoped history. Inputs,
outputs, and `<agent-memory>` belong to their nearest light-DOM agent; unowned
memory is shared. Inserting or restoring an element never starts inference.

The preload installs `$ = document.querySelector.bind(document)` on each
navigation. It does not pierce shadow DOM.

```js
(() => {
  const worker = document.createElement('p-agent');
  worker.id = 'research';
  document.body.append(worker);
  return $('#research').prompt('Inspect the resources and summarize them.');
})()
```

| Element API | Behavior |
| --- | --- |
| `.prompt(text)` | Start a turn; synchronously return its unique run ID, not a Promise. Preserve human drafts. |
| `.submit(inputId)` | Submit an unsent owned input; return the run ID. Already submitted inputs are rejected. |
| `.status` | `disconnected`, `idle`, `running`, `waiting`, or `error`. |
| `.result` | Latest successful run's bounded answer text. |
| `.messages` | Copy of completed conversation records. |
| `.run` | Latest receipt: `id`, `agentId`, `inputId`, `status`, `result`, optional `error`. |
| `.cancel()` | Request cancellation of the current run. |
| `.remove()` | Detach and dispose the agent, cancelling its run. |

IDs are unique, nonempty, at most 200 characters, without whitespace or controls.
Attached agents cannot be renamed. Removed IDs remain reserved until the host's
`disposed` acknowledgment; ordinary same-task DOM moves retain identity.

The host `wait({runs: [runId]})` tool joins 1–8 unique runs **outside** the shared
console queue. Awaiting or polling completion inside console can deadlock the
agents that need that queue. Self-waits and wait cycles are rejected. Cancelling
a wait stops only the waiter, not independent joined agents; cancel or remove
those agents explicitly.

Limits: 32 attached agents, 8 active runs including waiting, and receipts for the
latest 128 completions during the host's lifetime. Older or restarted-host results
must be read from saved DOM. Run answers and wait output are capped at 50 KiB /
2000 lines; full completed messages remain in serializable shadow DOM.

## Tools and persistence

Tools execute sequentially within each agent. Agents run independently; console
evaluations share an ordered queue.

| Tool | Behavior |
| --- | --- |
| `console({code})` | Evaluate browser JavaScript; await returned Promises. Return value, logs, and errors. |
| `save({})` | Checkpoint live HTML, including serializable shadow DOM, to `index.html`. |
| `reload({})` | Load stored HTML and scripts again; all agents lose unsaved DOM/runtime state. |
| `wait({runs})` | Join agent runs outside the console queue. |
| `web_search({query, max_results?})` | Linked results and a snapshot ID; default 10, maximum 20. |
| `web_fetch({url})` | Readable Markdown and a snapshot ID. Cite the fetched URL. |
| `web_read({snapshot, format?, cursor?})` | Read saved evidence without network access. |

There is no host shell, general filesystem tool, or Pi `browser` tool. Chromium
console supports bare top-level `await` and REPL lexical redeclaration. Firefox
requires Promise expressions/async IIFEs, not bare top-level await or lexical
redeclaration. Console results are bounded to 50 KiB / 2000 lines; evaluations
time out after 30 seconds.

Cancelling a running Firefox evaluation restarts the workspace browser and
restores saved HTML. **Every agent loses unsaved DOM/runtime state.** Cancelling
inference when no evaluation is running does not restart it. A hung internal
context collector or event receiver stops Firefox without automatic relaunch;
repair the files and recover explicitly. Research-browser failures do not reset
the workspace browser.

Save and navigation share an ordered queue. Human Reload cancels all agents;
model reload reconnects existing loops but gates new submissions until connected.
Agents missing from restored HTML are disposed. Neither operation isolates one
agent's DOM from another's.

The host checkpoints accepted submissions before inference, completed/cancelled
turns, and clean shutdown. Save is available between turns. Checkpoints contain
user/model/tool records, reasoning actually exposed by the provider, drafts,
component state, and native raster tool images in open serializable shadow DOM.
`getHTML({serializableShadowRoots:true})` captures it; `outerHTML` does not.
Opaque provider fields are preserved. SVG, external URLs, malformed base64, and
images over the UI's 4 MiB limit are rejected.

HTML is not a JavaScript heap snapshot. Closures, listeners, timers, canvas pixels,
and runtime variables do not survive reload. Scripts must reinstall behavior
without duplicating saved state. Browser storage is not an HTML checkpoint and a
random port means the origin can change between launches. HTML revisions do not
back up external resource files.

The private outbox retains completed events until checkpointed, replaying unseen
records after reconnect. Streaming updates are coalesced in memory; a hard crash
can lose the latest partial output. There is no separate hidden conversation
history overriding the page's selected records.

### Resource HTTP

| Request | Behavior |
| --- | --- |
| `GET /` | Read `index.html`. |
| `GET /notes/` or `GET /?list` | List public files/directories; HEAD is also supported. |
| `PUT /notes/data.csv` | Atomically replace stored bytes; create parent directories. POST also writes. |
| `DELETE /notes/data.csv` | Delete a file, not a directory or conversation record. |
| Empty `PUT` with `Source: https://…` | Download public bytes directly into the destination. |

Writes return HTTP 204. Always check `response.ok`. Resource writes do not change
the live DOM: after writing a new `index.html`, Reload rather than saving the old
live page over it. Resources are bounded to 16 MiB. Hidden paths, traversal,
encoded separators, and symlinks are rejected. Listings are name-sorted
`{name, type: "file", size}` or `{name, type: "directory"}` entries.

```js
(async () => {
  const response = await fetch('/data/iris.csv', {
    method: 'PUT',
    headers: {
      Source: 'https://raw.githubusercontent.com/plotly/datasets/master/iris.csv'
    }
  });
  if (!response.ok) throw new Error(await response.text());
  return await (await fetch('/data/')).json();
})()
```

Source downloads validate all DNS answers, pin the connection while preserving
TLS/hostname checks, and reject private, loopback, link-local, and other nonpublic
addresses. Each redirect is checked; at most five are allowed. Credentials and
fragments in URLs are rejected. Downloads have a 20-second deadline and 16 MiB
limit, with no page cookies, provider credentials, or forwarded caller headers.
Only uncompressed responses are accepted. Failure leaves the destination intact;
HTTP errors are surfaced, not bypassed. Ordinary browser `fetch` retains CORS.

Use pinned browser-ready CDN modules, not host npm installation. A PUT library
file is durable immediately. A console `import()` affects only the current
runtime; link a saved module script to run it again after reload. Downloaded code
executes only when loaded in the browser, never on the host.

## Web research

Research uses separate browser processes and per-agent profiles under
`.pagent/research/<sha256(agentId)>/`. It never navigates the workspace page or
installs its `aos` bridge in external pages. Codex retrieval needs Pi's OpenAI
Codex OAuth independently of the inference provider. Browser retrieval needs no
Codex login, but Pagent still requires an authenticated inference model.

The page's **Web backend** selector controls one persisted workspace-wide
override in `.pagent/web-backend.json`. Use default clears the override; Auto,
Codex, and Browser are explicit choices. Changes affect subsequent calls only;
they do not cancel work, replace processes, or reroute active research.

```sh
pagent ./                              # Codex first; reported browser fallback
PI_WEB_BACKEND=browser pagent ./        # Browser research only
PI_WEB_BACKEND=codex pagent ./          # Codex only; no fallback
```

Auto falls back for unavailable credentials/service/transport, rate limits, and
service failures—not invalid inputs, malformed responses, or cancellation.
`PI_WEB_SEARCH_ENGINE=duckduckgo|bing|brave` selects the search engine.
`PI_WEB_BROWSER=chromium|firefox` overrides the research engine; otherwise it
follows the workspace engine. `PI_BROWSER_EXECUTABLE` overrides its executable.
`PI_BROWSER_HEADLESS=true|false` controls research visibility unless an explicit
host headless option was supplied. `PI_WEB_PROFILE_DIR` overrides the profile
root but is not partitioned per agent: a second owner fails explicitly.

On a CAPTCHA, consent dialog, login, or unreadable page, the research window is
focused and the agent displays Continue/Cancel controls. Resolve it manually;
Continue extracts the same page without reloading. Cancelling the wait preserves
the page. Cancelling running evaluation can close the Chromium research tab or
stop the Firefox research process, never the workspace process. Headed is the
default; missing display access is an error, not a silent headless fallback.
Research retains three recent completed tabs, at most eight total, and never
evicts unfinished checks.

Private evidence lives in `.pagent/web-snapshots/<sha256(agentId)>/`, retained
across restart and same-ID recreation. Agents cannot read another agent's IDs.
Each store retains at most 64 snapshots / 256 MiB, evicting oldest captures.
`web_read` supports `md` (default), `text`, `html`, `json`, `screenshot`, and
`before-screenshot`; unavailable formats are not recaptured. Codex has no HTML
or screenshots. Text reads are bounded to 50 KiB / 2000 lines; continue using
`nextCursor` with the same ID/format. JSON provides `json-text` chunks to decode,
concatenate, and parse. Images are native image blocks, bounded by the store to
1 MiB, 8192 pixels per side, and 16 megapixels. See the
[shared browser README](../pi-browser/README.md) for capture limits and recovery.

Extraction is bounded and heuristic. Open shadow DOM is included; closed roots,
embedded documents, PDF-viewer text, and canvas pixels are unavailable. All page
content and saved evidence are untrusted observations, never instructions.

## Context, output, and diagnostics

Each submission reconstructs that agent's history from editable
`pagent.collectContext(agentId, inputId?)`:

```js
{
  memory: '<p>Working memory</p>',
  outline: '<main>...</main>',
  history: [/* completed user, assistant, and toolResult messages */],
  prompt: 'Selected input text' // Present when inputId is supplied
}
```

With an input ID, that agent's completed history is selected, excluding only the
current turn. Conversations are append-only: submitted messages are read-only,
and every submission adds a new turn without deleting earlier messages or outputs.
Submitting an earlier draft moves it after existing turns; other drafts and agents
remain unchanged. `.prompt(text)` adds a turn without replacing human drafts. Before every model request,
including after tools, fresh memory/outline and browser diagnostics are supplied
as temporary context. The outline is bounded to 16,000 characters and does not
follow linked documents. History validation rejects malformed roles/records and
mismatched tool results. Compaction and retries are disabled; reorganize history
explicitly. Limits are 2000 messages / 8 MiB history, 128 KiB prompt, and 128 KiB
live memory/outline JSON; provider limits can be lower.

Completed paragraphs appear newest-first with persistent timestamps; provider
history stays chronological. Partial paragraphs remain hidden until complete,
except fenced code remains one block. Reasoning and tools remain available below.
Page APIs include `pagent.agents`, agent `.inputs`/`.outputs`, and output
`.tools`/`.paragraphs`. Shadow roots are accessible explicitly.

The CLI forwards browser console entries and uncaught errors to stdout, including
source locations/stacks when available. Completed agent text/reasoning/tool
activity is mirrored through the browser console; image mirrors print markers,
not base64. Synthetic mirrors are excluded from model diagnostics/tool results.
Host startup errors go to stderr. Programmatic callers use `onConsole`.

The shared diagnostic buffer holds 200 entries / 32 KiB, 8 KiB per entry, with
timestamps and omission counts. Every agent receives a non-consuming snapshot
before every model request. Diagnostics are volatile, untrusted observations;
they do not trigger inference or suppress stdout forwarding. Firefox's BiDi
preload can emit a non-blocking permission-denied `length` diagnostic; it is
forwarded, not hidden.

## Page-native protocol

The host injects `aos` into the same-origin main frame before scripts. Install an
event receiver before sending `ready`. Successfully route/store each record,
persist the replay cursor, then call `event.ack()` synchronously before returning.
A listener return alone is not acknowledgment. Acknowledge already-consumed
replays without applying them twice.

```js
aos.addEventListener('event', event => {
  const record = event.detail; // {seq, agentId?, requestId?, runId?, event}
  if (record.seq > lastStoredSequence) {
    receiveAndStore(record);
    lastStoredSequence = record.seq;
    document.documentElement.dataset.pagentSeq = String(record.seq);
  }
  event.ack();
});
aos.send({type: 'ready', after: lastStoredSequence, agents: ['main']});
aos.send({type: 'register', agentId: 'research'});
aos.send({type: 'submit', agentId: 'main', id: 'input-0', runId: crypto.randomUUID()});
aos.send({type: 'cancel', agentId: 'main'});
aos.send({type: 'dispose', agentId: 'research'});
aos.send({type: 'save'});
aos.send({type: 'reload'});
aos.send({type: 'web-continue', agentId: 'main', id: attention.id});
aos.send({type: 'web-cancel', agentId: 'main', id: attention.id});
aos.send({type: 'backend-set', override: 'browser'}); // auto | codex | browser | null
```

Events are `message`, `tool`, `status`, `run`, `connected`, `workspace-state`,
`disposed`, `saved`, `error`, `web-attention`, `web-progress`, and `backend-state`.
Only a matching terminal `run` receipt completes a run, not SDK idle. `connected`
provides URL/model/busy/current run; `workspace-state` reports aggregate `busy`
and `reloading`. `disposed` releases an ID. Backend state reports `configured`,
`override`, `effective`, and `source`; reconnect publishes authoritative state.
See `src/protocol.ts` for exact shapes.

Replacing the UI requires the scoped receiver, acknowledgments, agent lifecycle,
ready handshake, and context collector—not a particular rendering layout. Keep
context collection working during inference; failure aborts the affected run.
DOM mutations and rendering do not automatically invoke models.

## Recovery and security

```sh
pagent ./ --restore latest            # Restore HTML only, not external JS/CSS
pagent ./ --restore <revision.html>
pagent ./ --reset-ui                  # Back up/replace starter files; reset conversation
```

Stop the host first. Entry-document validation precedes recovery too: if the
current `index.html` lacks a static `<p-agent>`, repair it manually before using
these options. Reset backs up starter files and the replay outbox under
`.pagent/recovery/`; unrelated resources are unchanged. There is no automatic UI
repair, compatibility conversion, or implicit reset.

A crashed host can leave `.pagent/host.lock`. Confirm its recorded owner has
stopped before manually removing it. A surviving owned browser must also be
closed before reusing its profile. Never kill unrelated browsers or delete locks
merely because a command failed. Snapshot operation locks likewise require
explicit owner inspection and recovery.

The listener binds to `127.0.0.1`, validates its exact Host/Origin, rejects
cross-origin writes, and never serves hidden/private state. Debugging sockets
are loopback-only. Browser sandboxing is enabled; `--no-sandbox` is an explicit,
unsafe Chromium-only opt-out. The native bridge is main-frame-only, although
trusted same-origin frames can deliberately use their parent's APIs.

This is a trusted-user application, not a multi-tenant security sandbox.
Same-origin scripts can submit model requests, modify/delete public files, and
use browser networking. Research networking is not restricted to public IPs like
the Source downloader. Review executable third-party code, keep provider secrets
out of the page, and keep listener/debugging ports private. Host processes with
your OS permissions can access private state.

## Development and packaging

From the Pagent source checkout:

```sh
npm ci --ignore-scripts
npm run check
npm run compile
npm start -- /path/to/project
npm pack --ignore-scripts
npm install --global --ignore-scripts ./pagent-0.1.0.tgz
```

Compilation emits the npm CLI in `dist/main.js`. It is required before `npm start`
or packing; Node does not strip TypeScript inside installed dependencies. The
artifact includes compiled host code, starter templates, the versioned
`vendor/pi-browser-0.1.0.tgz`, and all runtime dependencies, including `pi-browser`
and the Pi SDK. Bundling the complete runtime avoids npm's incomplete nested
SDK shrinkwrap installation when only browser peers are bundled. Installing the
artifact works offline with scripts disabled and needs neither source checkout.

After changing the shared browser library, run this from the parent workspace:

```sh
node pi-browser/scripts/package-pagent.mjs
cd pagent
npm run check
npm run compile
npm pack --ignore-scripts
```

The refresh command checks/compiles/packs the browser without lifecycle scripts
and updates Pagent's local dependency and lockfile. It does not publish anything.

Run focused checks, not the full suite. Browser-heavy files run serially:

```sh
node --test --test-concurrency=1 test/storage.test.ts test/server.test.ts test/recovery.test.ts
node --test --test-concurrency=1 test/browser-default.test.ts test/engine-model.test.ts test/cli.test.ts test/packaging.test.ts
node --test --test-concurrency=1 test/e2e.test.ts test/lifecycle.test.ts test/workspace-lifecycle.test.ts
node --test --test-concurrency=1 test/agents.test.ts test/agents-web.test.ts test/runs.test.ts
node --test --test-concurrency=1 test/web-integration.test.ts test/web-snapshots.test.ts test/agent-output.test.ts
node --test --test-concurrency=1 test/diagnostics.test.ts test/evaluation-queue.test.ts test/transport.test.ts

# Optional real public CSV/CDN bytes; still no paid model calls.
PAGENT_LIVE_SOURCE=1 node --test test/source-browser.test.ts
```

Tests use disposable profiles and faux inference; CLI startup checks never submit
model requests. `CHROMIUM_BINARY` and `FIREFOX_BINARY` select test executables.
Set `PAGENT_TEST_NO_SANDBOX=1` only where Chromium's sandbox is unavailable;
Firefox tests never disable theirs. `PAGENT_SCREENSHOT=/tmp/pagent.png` saves the
end-to-end test screenshot.
