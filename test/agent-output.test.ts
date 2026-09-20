import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import test from "node:test";

class Node {
  tag: string;
  className = "";
  textContent = "";
  src = "";
  alt = "";
  dataset: Record<string, string> = {};
  style: Record<string, string> = {};
  children: Node[] = [];
  constructor(tag: string) { this.tag = tag; }
  append(...nodes: Node[]) { this.children.push(...nodes.flatMap(node => node.tag === "fragment" ? node.children : [node])); }
  setAttribute() {}
}
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";
const content = [{ type: "text", text: "<script>not markup</script>" }, { type: "image", mimeType: "image/png", data: png }];
const source = await readFile(new URL("../template/agent-output.js", import.meta.url), "utf8");

function output() {
  // Exercise the actual component methods with a minimal DOM, without launching a browser.
  const context = {
    HTMLElement: Node, document: { createDocumentFragment: () => new Node("fragment") },
    clone: structuredClone, completedParagraphs: () => [], writeState: () => {},
    element(tag: string, className: string, text?: string) {
      const node = new Node(tag); node.className = className; node.textContent = text ?? ""; return node;
    },
  };
  const Constructor = runInNewContext(source.replace(/^import .*;\n/gm, "").replace("export class AgentOutput", "class AgentOutput") + "\nAgentOutput", context);
  return new Constructor();
}
function all(node: Node): Node[] { return [node, ...node.children.flatMap(all)]; }

test("live and finalized tool content renders raster images and plain text, never JSON/base64 dumps", () => {
  const component = output();
  for (const finalized of [false, true]) {
    component.state = { tools: [{ callId: "read", name: "web_read", phase: "end", result: { content } }], messages: [] };
    const tree = component.renderTool({ id: "read", name: "web_read", arguments: { snapshot: "opaque" } }, finalized ? { content } : undefined);
    const nodes = all(tree);
    assert.equal(nodes.filter(node => node.tag === "img").length, 1);
    assert.equal(nodes.find(node => node.tag === "img")?.src, `data:image/png;base64,${png}`);
    assert.equal(nodes.find(node => node.tag === "img")?.style.maxWidth, "100%");
    const text = nodes.map(node => node.textContent).join("\n");
    assert.match(text, /<script>not markup<\/script>/);
    assert.doesNotMatch(text, /iVBOR|mimeType/);
  }
});

test("unsupported MIME, URLs, malformed and oversized base64 are rejected for live and finalized images", () => {
  const component = output();
  const images = [
    { mimeType: "image/svg+xml", data: Buffer.from("<svg onload='alert(1)'/>").toString("base64") },
    { mimeType: "image/png", data: "https://example.com/pixel" },
    { mimeType: "image/png", data: "AAAA\" onerror=alert(1)" },
    { mimeType: "image/png", data: "A" },
    { mimeType: "image/png", data: "A".repeat(4 * Math.ceil(4 * 1024 * 1024 / 3) + 4) },
  ];
  for (const image of images) for (const finalized of [false, true]) {
    const content = [{ type: "image", ...image }];
    component.state = { tools: [{ callId: "read", result: { content } }] };
    const nodes = all(component.renderTool({ id: "read" }, finalized ? { content } : undefined));
    assert.equal(nodes.filter(node => node.tag === "img").length, 0);
    assert.match(nodes.map(node => node.textContent).join("\n"), /Image unavailable/);
  }
});

test("finalized images have one canonical state copy while tools API retains content", () => {
  const component = output();
  const details = { snapshot: "saved" };
  component.state = { tools: [{ callId: "read", result: { content, details } }], paragraphs: [], status: "complete",
    messages: [{ role: "toolResult", toolCallId: "read", content, details }] };
  component.render = () => {};
  component.persist();
  assert.equal(component.state.tools[0].result, undefined);
  assert.deepEqual(component.tools[0].result, { content, details });
  assert.equal(JSON.stringify(component.state).split(png).length - 1, 1);
  const large = "A".repeat(4 * Math.floor(4 * 1024 * 1024 / 3));
  const nodes = all(component.renderTool({ id: "read" }, { content: [{ type: "image", mimeType: "image/png", data: large }] }));
  assert.equal(nodes.filter(node => node.tag === "img").length, 1, "maximum-size base64 validates without regex stack overflow");
});
