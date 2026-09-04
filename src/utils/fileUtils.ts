import path from "path";

const IMAGES_DIR = process.env.IMAGES_DIR ?? "/images";

/**
 * Turns a stored or supplied value into an absolute path inside IMAGES_DIR, or
 * null when it is not a plain file name that belongs there.
 *
 * Every caller used to concatenate or join straight onto IMAGES_DIR. Express
 * decodes %2F inside a route parameter, so `DELETE /api/files/..%2F..%2Fdist%2F
 * index.js` reached path.join as "../../dist/index.js" and unlinkSync obeyed:
 * an administrator could delete any file the process could reach, not only
 * photographs.
 *
 * Hostile input is refused, never repaired. Silently stripping the dangerous
 * part is how a check turns into a bypass.
 */
export function resolveImagePath(value: unknown, directory = IMAGES_DIR): string | null {
  const name = imageFileName(value);
  if (name === null) return null;

  const root = path.resolve(directory);
  const resolved = path.resolve(root, name);
  // Belt and braces: whatever the checks above concluded, the answer must live
  // inside the directory.
  if (resolved !== root && !resolved.startsWith(root + path.sep)) return null;

  return resolved;
}

/**
 * The bare file name a stored image value refers to, or null when it is not a
 * plain name that belongs in IMAGES_DIR.
 *
 * Two shapes are stored: "/foto.jpg" for 3.090 rows and "images/foto.jpg" for
 * 424 more. Both name the same file inside IMAGES_DIR — the second is an older
 * upload path that survived in the data. The client already strips it the same
 * way. Only a *leading* run is removed, and every check below still applies to
 * the remainder, so "images/../secreto" is still refused.
 *
 * **This is the one place the two shapes meet, and everything that compares a
 * stored value with a file on disk has to go through it.** The Archivos screen
 * did not: it indexed the disk as `/name` and the database as whatever string
 * was stored, so the 424 `images/` rows never matched anything — "delete
 * orphans" would have removed every one of those photographs, and "clear broken
 * references" would have nulled every one of those rows. Found by an audit on
 * 3 September, before anybody pressed either button.
 */
export function imageFileName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const name = value.trim().replace(/^(?:[/\\]+|images[/\\]+)+/i, "");
  if (name === "") return null;
  // No separators, no traversal, no drive letters, no NUL byte.
  if (/[/\\]/.test(name) || name.includes("..") || /^[a-zA-Z]:/.test(name) || name.includes("\0")) {
    return null;
  }
  return name;
}

// There used to be a `deleteImageFile(stored)` here: resolve, then unlink, no
// questions asked. Every controller that replaced a photograph called it on the
// old value — and nothing checked that the old value was *this row's* to
// delete. A profile edit could name any file on the server as "my previous
// portrait" and have it removed. Its replacement is `deleteImageIfUnreferenced`
// in `imageRefs.ts`, which asks the database first.

export { IMAGES_DIR };
