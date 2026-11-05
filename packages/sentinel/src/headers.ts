// Security headers for every response. Pages that never talk to a wallet get a strict
// Content-Security-Policy; the Console loads wallet code through NEAR Connect (scripts and
// frames from many wallet origins), so it gets only the parts that can't break a sign-in.

/** On every response, pages and API alike. */
export const BASE_HEADERS: Readonly<Record<string, string>> = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
  "x-frame-options": "DENY",
  "strict-transport-security": "max-age=31536000; includeSubDomains",
  "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
};

/** The website and Sentinel: only our own scripts, our own API, NEAR RPC nodes and Google Fonts. */
export const STRICT_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src https://fonts.gstatic.com",
  "img-src 'self' data:",
  // The NEAR RPC, plus archival nodes for transactions older than ~2 days ("Verify it").
  "connect-src 'self' https://rpc.testnet.fastnear.com https://archival-rpc.testnet.fastnear.com https://archival-rpc.testnet.near.org",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "object-src 'none'",
].join("; ");

/** The Console: nobody can frame it (no clickjacking of Approve / Lock), no plugins, no <base> tricks. */
export const CONSOLE_CSP = ["frame-ancestors 'none'", "base-uri 'self'", "object-src 'none'"].join("; ");

/** Headers for a static file from public/. */
export function staticHeaders(file: string): Record<string, string> {
  const h: Record<string, string> = { ...BASE_HEADERS };
  if (file.endsWith(".html")) h["content-security-policy"] = file.endsWith("console.html") ? CONSOLE_CSP : STRICT_CSP;
  return h;
}
