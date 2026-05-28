import { describe, test, expect, vi, beforeEach } from "vitest";
import path from "path";

describe("getUploadDir", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
  });

  test("returns default uploads directory when UPLOAD_DIR is not set", async () => {
    delete process.env.UPLOAD_DIR;
    const { getUploadDir } = await import("./upload-dir");
    const result = getUploadDir();
    expect(result).toBe(path.join(process.cwd(), "uploads"));
  });

  test("returns absolute UPLOAD_DIR as-is", async () => {
    const absPath = path.resolve("/tmp/my-uploads");
    process.env.UPLOAD_DIR = absPath;
    const { getUploadDir } = await import("./upload-dir");
    const result = getUploadDir();
    expect(result).toBe(absPath);
  });

  test("resolves relative UPLOAD_DIR against cwd", async () => {
    process.env.UPLOAD_DIR = "./custom-uploads";
    const { getUploadDir } = await import("./upload-dir");
    const result = getUploadDir();
    expect(result).toBe(path.resolve(process.cwd(), "./custom-uploads"));
    expect(path.isAbsolute(result)).toBe(true);
  });

  test("resolves nested relative path", async () => {
    process.env.UPLOAD_DIR = "data/receipts";
    const { getUploadDir } = await import("./upload-dir");
    const result = getUploadDir();
    expect(result).toBe(path.resolve(process.cwd(), "data/receipts"));
  });
});

describe("resolveUploadPath", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
    delete process.env.UPLOAD_DIR;
  });

  test("resolves a valid relative path within upload dir", async () => {
    const { resolveUploadPath } = await import("./upload-dir");
    const result = resolveUploadPath("receipts/image.jpg");
    const expected = path.resolve(path.join(process.cwd(), "uploads"), "receipts/image.jpg");
    expect(result).toBe(expected);
  });

  test("throws on path traversal with ..", async () => {
    const { resolveUploadPath } = await import("./upload-dir");
    expect(() => resolveUploadPath("../etc/passwd")).toThrow("Path traversal detected");
  });

  test("throws on deeply nested path traversal", async () => {
    const { resolveUploadPath } = await import("./upload-dir");
    expect(() => resolveUploadPath("foo/../../etc/passwd")).toThrow("Path traversal detected");
  });

  test("throws on absolute path outside upload dir", async () => {
    const { resolveUploadPath } = await import("./upload-dir");
    expect(() => resolveUploadPath("/etc/passwd")).toThrow("Path traversal detected");
  });

  test("allows nested subdirectory within upload dir", async () => {
    const { resolveUploadPath } = await import("./upload-dir");
    const result = resolveUploadPath("a/b/c/file.png");
    const expected = path.resolve(path.join(process.cwd(), "uploads"), "a/b/c/file.png");
    expect(result).toBe(expected);
  });
});
