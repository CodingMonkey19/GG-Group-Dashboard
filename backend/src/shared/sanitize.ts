/**
 * sanitizeErrorMessage — strip operator-host-specific paths and other
 * leakable internals from an error string before it crosses a public
 * boundary (SSE event, HTTP error body).
 *
 * Per QA review H11 (`error` SSE event leaks absolute filesystem paths) and
 * Constitution Data Integration Constraints (no PII in operator-visible
 * surfaces), error messages emitted to the wire MUST NOT carry:
 *   - absolute POSIX paths (/Users/..., /home/..., /tmp/..., /var/...)
 *   - absolute Windows paths (C:\..., D:\...)
 * The verbose form remains in the server-side pino log for operator
 * diagnostics; only the sanitized form leaves the process.
 */

const POSIX_PATH = /\/(?:Users|home|tmp|var|opt|etc|root)\/[^\s'":<>|]+/g;
const WIN_PATH = /[A-Za-z]:\\[^\s'":<>|]+/g;
const MAX_LEN = 500;

export function sanitizeErrorMessage(input: string): string {
  let out = input;
  out = out.replace(POSIX_PATH, '<redacted-path>');
  out = out.replace(WIN_PATH, '<redacted-path>');
  if (out.length > MAX_LEN) {
    out = `${out.slice(0, MAX_LEN)}…`;
  }
  return out;
}
