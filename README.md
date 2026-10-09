# pagent

Pi agents whose workspace and user interface are one live browser page, backed by
an ordinary directory. The page owns its editors, conversation records, tool
display, working memory, and interaction policy. Agents can edit those files and
the live DOM.

Pagent is a standalone Node **24+** CLI, not a Pi extension. It uses Pi **1.1.0**
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
  agent-persistence.js         Opt-in same-element recovery after DOM removal
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
    turn-prompts/<uuid>.json  Resolved per-turn prompt evidence
    revisions/                 HTML checkpoints
    recordings/<id>/           Optional private DOM/PNG timeline and inert viewer
    recovery/                  Explicit recovery backups
```

Add `.pagent/` to your project's ignore rules if using version control. The
editable HTML, JavaScript, CSS, and other public resources are your project
files; updating the installed CLI does not replace them. Template files are
copied only when seeding a missing entry document or explicitly resetting the UI.

Programmatic hosts call `startPagent({ directory?: string, ... })`. The returned
app exposes `directory`, `stateDirectory`, `url`, `browser`, `agents` (a read-only
map of engines), `modelLabel`, `busy`, `executionState`, `start()`, `continue()`,
`stop()`, `getBackendState()`, `save()`, `flush()`, and `close()`. `close()` checkpoints
according to the configured policy and shuts down the host. The optional
`onExecutionState(state)` host callback observes execution transitions; it does
not grant the page access to continuation.

## Declarative agents and host configuration

Agent settings are ordinary HTML attributes:

```html
<p-agent id="one"
  model="provider/model"
  system-prompt-url="./prompt.md"
  tools="console,wait"
  mode="continuous"
  repeat-prompt-raw="do something"
  repeat-delay="1000"
></p-agent>
```

- `model` overrides the workspace default for that identity. Omit it to inherit.
  Pagent does not load ordinary Pi provider extensions; an extension-only model
  being available in Pi does not make it available here.
- System instructions use exactly one of `system-prompt-raw`, `system-prompt-url`,
  or `system-prompt-el`. They **replace** the normal system prompt, rather than
  appending. Omit all three for capability-aware stock instructions.
- Repeated input uses exactly one of `repeat-prompt-raw`, `repeat-prompt-url`, or
  `repeat-prompt-el`. Omit all three for manual-only input.
- `-raw` supplies literal text. `-url` names a local UTF-8 file relative to the
  resource root, read by the host, not fetched by page scripts. Absolute paths,
  external URLs, traversal, hidden paths, and symlinks are rejected.
- `-el` is a CSS selector matching **exactly one ordinary light-DOM element**.
  Its `textContent` supplies the prompt; shadow roots are not traversed. Invalid,
  missing, or ambiguous selectors fail. All resolved texts must be nonempty and
  at most **128 KiB UTF-8**. Empty declarations and conflicting sources fail too.
  The legacy `system-prompt` and `repeat-prompt` attributes are rejected, not aliases.
- `tools` is a comma-separated subset of the host's allowed tools. An empty value
  selects none. Unknown names and requests exceeding the host ceiling are errors.
- `mode="continuous"` repeats successful turns using the declared repeat source;
  it requires one. Omit mode to disable automatic repetition. `repeat-delay` is optional nonnegative milliseconds,
  overriding the host's `repeatDelayMs` (default 1000).

Configuration, including prompt **source definitions**, is pinned while the
identity is registered, including temporary detachment and pending disposal.
Changing these attributes is not a live model or permission switch; dispose and
await acknowledgment before reconfiguring. Referenced file/element **contents**
are deliberately live: each new turn resolves its instructions once, and tool
rounds keep that snapshot unchanged. Edits affect later turns, including fresh
turns after operator continuation, not a turn already running. Manual `.prompt()`
and `.submit()` resolve the system source but use their submitted input instead
of the repeat source. Explicit closing tags are required; HTML custom elements
are not self-closing.

For shared editable instructions:

```html
<pre id="instructions" contenteditable="true">Your environment is this page.</pre>
<p id="task" contenteditable="true">Inspect the page.</p>
<p-agent id="one" system-prompt-el="#instructions" repeat-prompt-el="#task"></p-agent>
```

Each accepted turn records the actual resolved prompts before inference. A scoped
`turn-prompts` event carries `{resolvedAt, system:{source,text}, user:{source,text}}`;
`resolvedAt` is an ISO timestamp, and sources are `{kind:"raw"|"url"|"el",value}`.
The system source is `null` for stock instructions; manual input has a `raw`
source. The stock UI stores this as the matching `agent-output.state.prompts` in
serializable shadow state, not public prose or an extra model-history message.
The host also atomically writes `.pagent/turn-prompts/<uuid>.json` containing
`{agentId,inputId,runId,prompts}` under **every checkpoint policy**, including
`none`. These prompt-only records are analysis evidence: they never replay a
conversation or restart inference. HTML durability still follows checkpoint policy.

HTTP and network policy are **page-wide**, because every agent shares the same
JavaScript environment. There is intentionally no per-agent `http` attribute
claiming isolation that cannot be enforced.

Load host settings only through an explicit JSON path:

```sh
pagent ./piece --config ./piece/.pagent-config.json
pagent ./piece --http GET --network local --tools console,wait \
  --checkpoint private --duration 600 --repeat-delay 1000 \
  --record 30000 --viewport 1440x1000 --browser chromium
```

```json
{
  "browser": "chromium",
  "network": "local",
  "http": ["GET"],
  "tools": ["console", "wait"],
  "checkpoint": "private",
  "durationMs": 600000,
  "repeatDelayMs": 1000,
  "record": { "intervalMs": 30000, "screenshots": true, "events": ["tool", "thinking", "message"] },
  "viewport": { "width": 1440, "height": 1000 }
}
```

The same keys are `startPagent` options. JSON also accepts `model`, `thinking`,
and `headless`. Unknown keys and malformed values are rejected before workspace
startup; no config file is discovered automatically. CLI flags override JSON.
`--duration` uses seconds; JSON duration and repetition/recording intervals use
milliseconds. Optional `deadlinePolicy:"close"|"pause"` (CLI
`--deadline-policy close|pause`) defaults to `close`. `pause` requires `durationMs`. `--record` enables DOM and PNG recording; JSON can set
`screenshots:false` and opt into completion triggers through `events` (see below).
Viewport dimensions are CSS pixels from 1 through 8192.

Defaults preserve the ordinary writable workspace: all tools, all resource
methods, open networking, document checkpoints, and no duration or recording.
`network:"local"` also removes web research tools. Host tool selection is a
ceiling; an element cannot grant itself excluded tools. Agents sharing a page
can still invoke one another, so per-agent tool selection is not an isolation
boundary.

`checkpoint:"document"` writes the live HTML to `index.html` as usual.
`"private"` writes only `.pagent/revisions/`, leaving the original document
unchanged. `"none"` disables HTML checkpoints. Private recordings are independent
of checkpoint policy. With private/none policies, restart and reload use the
original document, not the last live DOM. Their delivery outbox is in memory only:
these modes neither read nor change a previous document-mode outbox, and discard
old runtime events on reload. Document mode retains its durable crash-recovery outbox.

### Starting and repeating

`pagent.start()` in the page (or `app.start()` in the host) explicitly starts the
execution. It captures the participating agents with a repeat prompt source, starts the
optional duration clock and recorder, and prompts them concurrently. Calling it
again nudges idle participants; busy agents do not accumulate prompts.
`pagent.nudge()` nudges an already-running execution without starting one. Ordinary
manual submissions remain available without a configured finite duration; a
finite execution is armed until explicitly started.

Continuous agents repeat only after a successful terminal run and the configured
delay. Errors and cancellations pause repetition; a later nudge can retrigger the
agent. The host owns scheduling and never trusts page timers or editable status
fields. Removed participants are retired, and newly attached agents are not
silently enrolled in an already-running execution. Context exhaustion is an
explicit error, not an automatic history reset.

`pagent.stop()` / `app.stop()` stops admission and repetition. By default, the
deadline and host closure use the same terminal path: stop periodic recording,
attempt a bounded final capture of the live page, then cancel work without browser recovery.
A six-second cleanup budget starts immediately, even without a configured duration;
if cancellation stalls, Pagent closes the owned browser and ends cleanup rather
than waiting indefinitely. Closing the browser ends page animations too. The page can alter its
own controls but not extend the host deadline. Starting after a stopped execution
requires a new host; reloads do not automatically resume repetition.

### Pausing at the deadline and continuing

For an explicit operator decision after each interval:

```sh
pagent ./piece --duration 600 --deadline-policy pause
```

Or set `{"durationMs":600000,"deadlinePolicy":"pause"}` in explicit JSON config
or `startPagent` options. At the deadline, admission and repetition stop immediately,
active requests are cancelled, and execution moves through `pausing` to `paused`
while retaining the owned browser. DOM, JavaScript state and listeners remain in
the live page. A running console evaluation is detached, not terminated: its
already-started JavaScript, timers, and animations can still run or mutate the
page during a pause and later intervals. This is **not** a frozen world or a
suspended provider request.

Only after `paused`, the host's `await app.continue()` starts another interval of
the configured duration and fresh turns for surviving original participants,
using retained completed history and new run IDs. It does not replay interrupted
tools or resume an old model request. No automatic continuation occurs. Failed
pause settlement is not permission to restart inference: failure or a six-second
settlement timeout terminally closes the host instead. Repeated continuation
is explicit each time. Closing the browser loses this live continuation option;
saved HTML is not an equivalent reconstruction of its JavaScript heap.

The CLI installs line-based operator commands for pause policy: type `continue`
and Enter to request another interval, or `finish` and Enter to close the host.
Commands are in the **host terminal**, not the page. `continue` reports an error
unless the execution is paused; it cannot extend a still-running interval.
`finish`, Ctrl+C, SIGTERM, `app.stop()` and `app.close()` remain terminal.
The page's start/nudge/submit requests cannot resume a paused execution, and there
is no native `continue` request or page API that grants more time.

Custom hosts can reuse `installOperatorControls(app, {input?, output?})` from
`src/terminal.ts` (compiled: `dist/terminal.js`). Streams default to `process.stdin`
and `process.stdout`; the helper returns an idempotent disposer. It accepts an
object with async `continue()` and `close()` methods. Install only when wanted,
and dispose on `onExecutionState("stopped")`, shutdown or startup failure. Input
EOF removes the controls but does not implicitly finish the experiment. Continuation
errors are printed and do not queue retries; `finish` is not held behind a pending
continuation. This helper is not exposed to page scripts.

### Private recording and playback

Recording begins at explicit kickoff, with a baseline before prompting. The host
samples the effective HTML (including serializable shadow DOM) and optional PNGs
without page timers, save events, or agent messages. Evidence is written under
`.pagent/recordings/<unique-id>/`, never through the resource HTTP server.

Each archive contains `manifest.jsonl`, `frames/`, and an inert `viewer.html`.
Open the viewer in an ordinary browser and select the recording folder to scrub
or play its screenshots. It does not execute archived HTML. The manifest records
planned and actual capture times, missed samples, errors, and the final capture.
A deadline pause finishes that interval's archive and stops sampling while paused.
Each operator continuation creates a new archive with its own baseline and a
`previous` archive-directory name in the manifest's `start` record. Earlier
archives are not rewritten. Final capture may overlap request cancellation;
recordings are evidence, not resumable provider checkpoints.

Optional `record.events` selects additional captures after acknowledged page delivery:
- `"tool"`: tool execution ended, including error results.
- `"thinking"`: the SDK emitted the end of a reasoning block exposed by the provider.
- `"message"`: an assistant message ended (including tool-call messages and interrupted
  messages), not a user/tool-result message or streaming token.

Omit `events` or use `[]` for periodic-only recording. For example,
`{"intervalMs":30000,"screenshots":true,"events":["tool","thinking","message"]}`
combines 30-second samples with completion captures. Triggers are host-owned, never
page-requested, and do not invoke save/checkpoint or delay model work. Failed delivery
and reconnect replay do not trigger captures. Stop, reload, runtime invalidation,
and teardown disable completion sampling and cancel pending triggers.

Concurrent completions share one pending batch. Capture is scheduled one second
after the first completion, or one second after an in-flight capture settles; later
completions do not push that deadline back. A periodic frame can absorb the batch.
There is no per-event capture queue or immediate capture-after-capture loop. Each
frame/error records up to 32 completion attributions (kind, sequence, agent/run/input,
call or reasoning-block index, and delivery time), plus an omitted-event count.
Identifiers are capped at 200 characters; message/tool payloads are not copied into
attribution. A trigger cancelled by stop/reload is reported as a skip. Captures are
best-effort later observations, not an exact visual frame for every completion.

Intervals are a target cadence: only one capture is in flight; delayed/busy
samples are skipped, not queued. Capture and shutdown waits are bounded, so a
hung renderer may leave gaps or no final frame. DOM and screenshots are separate
observations, not atomic frames. HTML is not a heap snapshot: JavaScript closures,
listeners, property-only state, CSSOM edits, canvas/WebGL pixels, and animation
phase cannot all be reconstructed from it. Recording overhead is not guaranteed
undetectable, and archives can consume substantial disk space.

## Agents and runs

The starter's `<p-agent id="main">` is an ordinary agent, not a privileged parent.
Full `<p-agent>` elements can appear anywhere in light DOM, including ordinary
containers and nested agents. Agents share DOM/runtime and resource files, with
a common model default but optional per-element models, independent inference,
and scoped history. Inputs, outputs, and `<agent-memory>` belong to their nearest light-DOM agent; unowned
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
| `.remove()` | Ordinary DOM removal: recover if persistence is enabled, otherwise dispose. |
| `.dispose()` | Permanently remove this agent, bypassing persistence and cancelling its run. |

IDs are unique, nonempty, at most 200 characters, without whitespace or controls.
Registered agents cannot be renamed. Disposed IDs remain reserved until the
host's `disposed` acknowledgment; ordinary same-task or next-microtask DOM moves
retain identity. Explicitly reinserting an element after acknowledgment registers
it again; neither recovery nor registration automatically prompts it.

### Persistent elements

```html
<p-agent id="one" persist-end="body"></p-agent>
<!-- Alternatively: persist-start="#some-container" -->
```

Opt in with exactly one of `persist-start` or `persist-end`, whose value must be a
nonempty valid CSS selector. Without either, removal disposes normally. Settings
are validated before registration and pinned even while temporarily detached.

After a subtree or whole-body replacement, a shared microtask batch reattaches
**the same registered element**, before any disposal request. Its conversation,
shadow DOM, drafts, listeners, identity, and active run survive; there is no
cloning, new prompt, or second transcript store. Ordinary DOM moves are no-ops.
Recovery uses registration order (including stable prepend order), restoring
persistent ancestors before descendants to preserve nesting. Explicit `.dispose()`
removes only that identity permanently; independently persistent children can
recover outside it. `.cancel()` affects only the current run.

Targets are resolved afresh on every recovery. A missing match warns in the
browser console and falls back to the current `document.body`. Targets must be
connected HTML containers, not void elements or the agent's own subtree. Invalid
targets, no valid body, or unrelated ID collisions report an error and dispose
normally, without retries or deleting artwork. Fresh unregistered same-ID
`p-agent` replacements are rejected/removed in favor of the original, including
when `body.innerHTML = body.innerHTML` reparses the page.

Page stop requests suppress recovery immediately; terminal host stop/deadline and
reload state events, and page teardown, also suppress it. A nonterminal deadline
pause retains ordinary element recovery without starting inference. Recovery never restarts stopped
execution or changes host deadlines. This handles accidental subtree removal,
not hostile scripts, cleared agent internals, rewritten bridges/prototypes,
navigation, or repeated removal loops. It preserves existence, not visibility or
non-agent controls. Existing project-owned UI modules need explicit updating;
installing a new CLI does not replace them.

The host `wait({runs: [runId]})` tool joins 1–8 unique runs **outside** the shared
console queue. Awaiting or polling completion inside console can deadlock the
agents that need that queue. Self-waits and wait cycles are rejected. Cancelling
a wait stops only the waiter, not independent joined agents; cancel or remove
those agents explicitly (use `.dispose()` for persistent elements).

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
| `save({})` | Checkpoint live HTML and serializable shadow DOM according to host policy. |
| `reload({})` | Load stored HTML and scripts again; all agents lose unsaved DOM/runtime state. |
| `wait({runs})` | Join agent runs outside the console queue. |
| `web_search({query, max_results?})` | Linked results and a snapshot ID; default 10, maximum 20. |
| `web_fetch({url})` | Readable Markdown and a snapshot ID. Cite the fetched URL. |
| `web_read({snapshot, format?, cursor?})` | Read saved evidence without network access. |

The table lists the default tools; host and element settings can restrict them.
There is no host shell, general filesystem tool, or Pi `browser` tool. Chromium
console supports bare top-level `await` and REPL lexical redeclaration. Firefox
requires Promise expressions/async IIFEs, not bare top-level await or lexical
redeclaration. Console results are bounded to 50 KiB / 2000 lines; evaluations
time out after 30 seconds.

Ordinary per-agent cancellation of a running Firefox evaluation restarts the
workspace browser and restores saved HTML. **Every agent loses unsaved DOM/runtime
state.** A configured deadline pause instead detaches a running evaluation without
resetting the page; its JavaScript may continue. Terminal stop, default deadline,
and host shutdown disable recovery before final capture; they never restart an
original document as a final recorded frame. Cancelling
inference when no evaluation is running does not restart it. A hung internal
context collector or event receiver stops Firefox without automatic relaunch;
repair the files and recover explicitly. Research-browser failures do not reset
the workspace browser.

Save and navigation share an ordered queue. Human Reload cancels all agents;
model reload reconnects existing loops but gates new submissions until connected.
Agents missing from restored HTML are disposed. Neither operation isolates one
agent's DOM from another's.

Unless checkpointing is disabled, the host checkpoints accepted submissions
before inference, completed/cancelled turns, and clean shutdown. Save is available
between turns when enabled. Checkpoints contain
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

In document-checkpoint mode, the private outbox retains completed events until
checkpointed, replaying unseen records after reconnect. Streaming updates are coalesced in memory; a hard crash
can lose the latest partial output. There is no separate hidden conversation
history overriding the page's selected records.

### Resource HTTP

The page-wide `http` option restricts methods; `GET` also permits `HEAD` and
includes directory listings. For example, `http:["GET"]` exposes read-only local
resources and listings. The following table describes the unrestricted default.
`network:"local"` additionally rejects `Source` downloads.

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

Each agent researches in its own browser of the workspace engine, with a stable
profile under `.pagent/research/<sha256(agentId)>/`. Pi-browser's broker holds
that browser for the agent and closes it when the agent's engine closes. Research
never navigates the workspace page or installs its `aos` bridge in external pages.
Research tabs are named automatically (host without `www.` plus `+<length>` of the
rest of the URL); attention requests report that name. Codex retrieval needs Pi's OpenAI
Codex OAuth independently of the inference provider. Browser retrieval needs no
Codex login, but Pagent still requires an authenticated inference model.

The page's **Web backend** selector controls one persisted workspace-wide
override in `.pagent/web-backend.json`. Use default clears the override; Auto,
Codex, and Browser are explicit choices. Changes affect subsequent calls only;
they do not cancel work, replace processes, or reroute active research.

```sh
pagent ./                              # Browser research only by default
PI_WEB_BACKEND=auto pagent ./           # Codex first; reported browser fallback
PI_WEB_BACKEND=browser pagent ./        # Browser research only
PI_WEB_BACKEND=codex pagent ./          # Codex only; no fallback
```

Auto falls back for unavailable credentials/service/transport, rate limits, and
service failures—not invalid inputs, malformed responses, or cancellation.
`PI_WEB_SEARCH_ENGINE=duckduckgo|bing|brave` selects the search engine.
Research always follows the workspace engine. `PI_BROWSER_HEADLESS=true|false`
controls research visibility unless an explicit host headless option was supplied.

On a CAPTCHA, consent dialog, login, or unreadable page, the research window is
focused and the agent displays Continue/Cancel controls. Resolve it manually;
Continue extracts the same page without reloading. Cancelling the wait preserves
the page. Cancelling running evaluation closes only that research tab, never the
workspace process. Headed is the default; missing display access is an error,
not a silent headless fallback. Research keeps the agent's ten most recently
used tabs and closes older ones.

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

### Public final responses

```html
<p-agent id="one" public-html></p-agent>
```

The boolean `public-html` attribute opts that agent's completed final assistant
text into **ordinary light DOM** under its `agent-output` elements. For example,
`$('#one').querySelector('agent-output').textContent` and `$('#one').outerHTML`
include that prose without traversing shadow roots. Named slots display these
same paragraph nodes in their usual newest-first positions, with the original
timestamps; they are not a second visible transcript. Text remains inert plain
text, including code and markup written in the answer.

Only completed assistant messages with `stopReason:"stop"` and no tool calls
qualify. Streaming text, tool-call commentary, interrupted/truncated answers,
reasoning, tool arguments/results, and provider metadata remain in existing
shadow state/rendering. Full chronological conversation records remain canonical
there; save/reload and persistent-element recovery retain the same history and
run identity. This is presentation/discoverability, **not access control**: open
shadow roots and the existing `.messages` API remain accessible to page scripts.

Without the attribute, output stays in shadow DOM as before. The setting is
pinned while registered, applies only to the nearest owning agent (not nested
agents), and does not change host configuration or start inference. Existing
project-owned UI modules need explicit updating or fresh setup.

The stock outline follows ordinary light DOM: it retains public output just as
it retains other page text, subject to its existing 16,000-character bound. It
still does not traverse shadow transcripts. There is no separate peer feed,
summary, notification, or instruction to communicate. Editable
`pagent.collectContext` remains the page's context policy.

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
aos.send({type: 'ready', after: lastStoredSequence, agents: [{agentId: 'main'}]});
aos.send({type: 'register', agentId: 'research', model: 'provider/model', tools: ['console', 'wait']});
aos.send({type: 'submit', agentId: 'main', id: 'input-0', runId: crypto.randomUUID()});
aos.send({type: 'cancel', agentId: 'main'});
aos.send({type: 'dispose', agentId: 'research'});
aos.send({type: 'start'}); // Later start/nudge requests nudge idle participants.
aos.send({type: 'stop'});
aos.send({type: 'save'});
aos.send({type: 'reload'});
aos.send({type: 'web-continue', agentId: 'main', id: attention.id});
aos.send({type: 'web-cancel', agentId: 'main', id: attention.id});
aos.send({type: 'backend-set', override: 'browser'}); // auto | codex | browser | null
```

Ready/register agent descriptors carry `agentId` and optional `model`,
`systemPromptSource`, `tools` (array), `mode`, `repeatPromptSource`, and
`repeatDelayMs`. Both prompt-source fields use `{kind:"raw"|"url"|"el",value:string}`;
legacy `systemPrompt` and `repeatPrompt` fields are rejected. Stock elements expose
their pinned descriptor as `.configuration`.
Ready requests use descriptors, not bare ID strings; custom UIs must send this
protocol and existing project-owned stock modules must be updated explicitly.

Events are `message`, `tool`, `turn-prompts`, `status`, `run`, `connected`, `workspace-state`,
`execution-state`, `disposed`, `saved`, `error`, `web-attention`, `web-progress`,
and `backend-state`. Only a matching terminal `run` receipt completes a run,
not SDK idle. `connected` provides URL/model/busy/current run/effective tools;
`workspace-state` reports aggregate `busy` and `reloading`. `execution-state`
reports `armed`, `running`, `pausing`, `paused`, or `stopped`. `disposed` releases an ID. Backend state reports `configured`,
`override`, `effective`, and `source`; reconnect publishes authoritative state.
A `message` update may carry `thinkingEnd` with the SDK's completed reasoning-block
index; normal rendering still uses its message snapshot. See `src/protocol.ts` for
exact shapes.

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
By default, same-origin scripts can submit model requests, modify/delete public
files, and use browser networking. Research networking is not restricted to public
IPs like the Source downloader. Review executable third-party code, keep provider
secrets out of the page, and keep listener/debugging ports private. Host processes
with your OS permissions can access private state.

`network:"local"` uses a response-header CSP and debugger request/navigation
controls to block ordinary external page access. Same-origin GET/listing remains
available when allowed by `http`; data/blob images and inline CSS remain usable.
External scripts, frames, workers, forms, and research tools are unavailable.
CORS alone is not an outbound firewall, and these controls are not OS-enforced
network isolation: browser background traffic and deliberate bypass attempts are
outside this guarantee. Every agent shares the page and can modify peers and UI.
The mode is intended to keep agents operating locally, not execute hostile code.

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
node --test test/config.test.ts test/terminal.test.ts test/recording.test.ts test/agent-config.test.ts test/execution.test.ts
node --test --test-concurrency=1 test/configured-agents.test.ts test/execution-pause.test.ts test/execution-shutdown.test.ts test/recording-events.test.ts test/server-policy.test.ts test/browser-policy.test.ts
node --test --test-concurrency=1 test/storage.test.ts test/server.test.ts test/recovery.test.ts
node --test --test-concurrency=1 test/browser-default.test.ts test/engine-model.test.ts test/cli.test.ts test/packaging.test.ts
node --test --test-concurrency=1 test/e2e.test.ts test/lifecycle.test.ts test/workspace-lifecycle.test.ts
node --test --test-concurrency=1 test/agents.test.ts test/agents-web.test.ts test/runs.test.ts
node --test --test-concurrency=1 test/persistence.test.ts test/persistent-runs.test.ts test/template.test.ts
node --test --test-concurrency=1 test/web-integration.test.ts test/web-snapshots.test.ts test/agent-output.test.ts
node --test --test-concurrency=1 test/public-html.test.ts test/paragraphs.test.ts
node --test --test-concurrency=1 test/diagnostics.test.ts test/evaluation-queue.test.ts test/transport.test.ts

# Optional real public CSV/CDN bytes; still no paid model calls.
PAGENT_LIVE_SOURCE=1 node --test test/source-browser.test.ts
```

Tests use disposable profiles and faux inference; CLI startup checks never submit
model requests. `CHROMIUM_BINARY` and `FIREFOX_BINARY` select test executables.
Set `PAGENT_TEST_NO_SANDBOX=1` only where Chromium's sandbox is unavailable;
Firefox tests never disable theirs. `PAGENT_SCREENSHOT=/tmp/pagent.png` saves the
end-to-end test screenshot.
