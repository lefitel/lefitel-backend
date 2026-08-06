import fs from "fs";
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
  if (typeof value !== "string") return null;

  // Two shapes are stored: "/foto.jpg" for 3.090 rows and "images/foto.jpg"
  // for 424 more. Both name the same file inside IMAGES_DIR — the second is an
  // older upload path that survived in the data. The client already strips it
  // the same way. Only a *leading* run is removed, and everything below still
  // applies to the remainder, so "images/../secreto" is still refused.
  const name = value.trim().replace(/^(?:[/\\]+|images[/\\]+)+/i, "");
  if (name === "") return null;
  // No separators, no traversal, no drive letters, no NUL byte.
  if (/[/\\]/.test(name) || name.includes("..") || /^[a-zA-Z]:/.test(name) || name.includes("\0")) {
    return null;
  }

  const root = path.resolve(directory);
  const resolved = path.resolve(root, name);
  // Belt and braces: whatever the checks above concluded, the answer must live
  // inside the directory.
  if (resolved !== root && !resolved.startsWith(root + path.sep)) return null;

  return resolved;
}

/**
 * Deletes an image given its stored path (e.g. "/1234_photo.jpg").
 * Errors are ignored on purpose: the file may already be gone.
 */
export function deleteImageFile(imagePath: string | null | undefined): void {
  const fullPath = resolveImagePath(imagePath);
  if (fullPath === null) return;
  fs.unlink(fullPath, () => {});
}

export { IMAGES_DIR };
