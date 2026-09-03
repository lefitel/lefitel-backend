// One way to hide a recovery address in anything a person or a log will read.
//
// Lived in `securityNotice.ts` until plan 4E, and `securityNotice.ts` still
// re-exports it. Moved here because the mail relay (`mailRelay.ts`) and the
// door in front of it (`mailer.ts`) need it for their own log lines, and
// `securityNotice.ts` imports `mailer.ts`: importing back from it would have
// closed an import cycle around the one function every notice depends on.
// Nothing else changed — same shape, same callers.

/**
 * `isaias@osefi.net` → `i***@osefi.net`. The first letter and the domain are
 * what let the owner recognise the address; the rest is what a stranger
 * would need to type it.
 */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf("@");
  // No `@` at all, or one at either end: not an address this can reason
  // about, so nothing is revealed rather than guessed at.
  if (at <= 0 || at === email.length - 1) return "***";
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  return `${local[0]}***@${domain}`;
}
