import { findBrowserExecutable } from "pi-browser";
import type { BrowserKind } from "./protocol.ts";

/** Prefer installed Firefox, using the same executable discovery as browser startup. */
export async function detectBrowser(): Promise<BrowserKind> {
  return await findBrowserExecutable("firefox") ? "firefox" : "chromium";
}
