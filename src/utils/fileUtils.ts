import fs from "fs";

const IMAGES_DIR = process.env.IMAGES_DIR ?? "/images";

/**
 * Deletes an image file from disk given its stored DB path (e.g. "/1234_photo.jpg").
 * Silently ignores errors (file already deleted, doesn't exist, etc).
 */
export function deleteImageFile(imagePath: string | null | undefined): void {
  if (!imagePath) return;
  const fullPath = IMAGES_DIR + imagePath;
  fs.unlink(fullPath, () => {});
}

export { IMAGES_DIR };
