import { join, isAbsolute, resolve } from "path";

/**
 * Returns the absolute path to the upload directory.
 * Uses UPLOAD_DIR env var if set (resolved to absolute if relative),
 * otherwise defaults to an "uploads" folder relative to the project root.
 */
export function getUploadDir(): string {
  const envDir = process.env.UPLOAD_DIR;
  if (envDir) {
    return isAbsolute(envDir) ? envDir : resolve(process.cwd(), envDir);
  }
  return join(process.cwd(), "uploads");
}
