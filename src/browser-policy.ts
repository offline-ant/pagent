import type { BrowserPageOptions } from "./protocol.ts";

/** Relaxed page confinement. Browser networking outside page requests is not covered. */
export const LOCAL_CONTENT_POLICY = [
  "default-src 'none'",
  "script-src 'self'",
  "script-src-attr 'none'",
  "style-src 'self' 'unsafe-inline'",
  "connect-src 'self'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "media-src 'self' data: blob:",
  "object-src 'none'",
  "frame-src 'none'",
  "worker-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

export function validateBrowserPolicy(options: Pick<BrowserPageOptions, "network" | "viewport">): void {
  if (options.network !== undefined && options.network !== "open" && options.network !== "local") {
    throw new Error("Network policy must be open or local.");
  }
  if (options.viewport && (![options.viewport.width, options.viewport.height].every(value => Number.isInteger(value) && value > 0 && value <= 8192))) {
    throw new Error("Viewport width and height must be integers from 1 through 8192.");
  }
}

export function localResource(url: string, origin: string): boolean {
  const target = new URL(url);
  return target.origin === origin || target.protocol === "data:" || (target.protocol === "blob:" && target.origin === origin);
}
