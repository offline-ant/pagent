import { parse, type DefaultTreeAdapterMap } from "parse5";

/** Templates, comments, script text and foreign elements are not attached HTML agents. */
export function validateEntryDocument(html: string): void {
  const pending: DefaultTreeAdapterMap["node"][] = [parse(html)];
  while (pending.length) {
    const node = pending.pop()!;
    if ("tagName" in node && node.tagName === "p-agent" && node.namespaceURI === "http://www.w3.org/1999/xhtml") return;
    if ("childNodes" in node) for (const child of node.childNodes) pending.push(child);
  }
  throw new Error("Warning: index.html contains no static <p-agent> element. Add a <p-agent id=\"main\"> and its UI scripts before running pagent.");
}
