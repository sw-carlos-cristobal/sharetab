import { join, isAbsolute } from "path";

/**
 * Returns the absolute path to the upload directory.
 * Uses UPLOAD_DIR env var if set (must be absolute), otherwise defaults
 * to an "uploads" folder relative to the project root.
 */
export function getUploadDir(): string {
  const envDir = process.env.UPLOAD_DIR;
  if (envDir) {
    if (!isAbsolute(envDir)) {
      throw new Error("UPLOAD_DIR must be an absolute path");
    }
    return envDir;
  }
  return join(process.cwd(), "uploads");
}
