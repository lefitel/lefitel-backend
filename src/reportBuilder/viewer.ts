// Who is asking, and what they are allowed to see.
//
// Field visibility used to be a list of role numbers written into the catalog:
// `roles: [1, 2]` on every column holding somebody's personal data. Two things
// were wrong with that. The list disagreed with the permission matrix — role 2
// has no `seguridad.ver`, so `GET /usuario` answered it 403 while the generator
// handed the same person names, login usernames, phone numbers and the name of
// their role — and there was no way to correct it from the Seguridad screen,
// because the answer was a literal in the source.
//
// So the catalog now declares *what a field is* — `staffOnly: true`, personal
// data belonging to somebody else — and the request decides *who is asking*.
// The answer is resolved once per request at the edge, where reaching the
// database is allowed; everything below stays a pure function of a plain
// object, which is what makes the builder testable without one.

/** The caller, as everything under the controller sees them. */
export interface Viewer {
  /** The caller's role. Carried for messages and logs, not for decisions. */
  role: number;
  /**
   * May see other people's personal data. Resolved from `seguridad.ver`, the
   * same permission that guards the screen where that data is administered.
   */
  staff: boolean;
}

/**
 * A viewer who may see nothing personal.
 *
 * Exists so that a caller with no session, or one whose permissions could not
 * be read, still has a viewer to pass — and the one it gets is the closed one.
 * A permission system that guesses "yes" when it is unsure is not one.
 */
export const anonymous = (role = -1): Viewer => ({ role, staff: false });

/**
 * Whether a catalog entry is visible to this viewer.
 *
 * One line, in one place, deliberately: the previous version of this question
 * was answered by two identical helpers in two files plus a third literal in a
 * controller, and they drifted — which is how the leak survived a permission
 * migration that was supposed to remove every role number from the codebase.
 */
export const isVisible = (staffOnly: boolean | undefined, viewer: Viewer): boolean =>
  staffOnly !== true || viewer.staff === true;
