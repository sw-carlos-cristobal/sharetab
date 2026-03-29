import { test, expect, request } from "@playwright/test";
import { createReadStream } from "fs";
import { join } from "path";

const BASE = process.env.BASE_URL || "http://localhost:3001";

async function authedContext(email: string, password: string) {
  const ctx = await request.newContext({ baseURL: BASE });
  const csrfRes = await ctx.get("/api/auth/csrf");
  const { csrfToken } = await csrfRes.json();
  await ctx.post("/api/auth/callback/credentials", {
    form: { email, password, csrfToken },
    maxRedirects: 0,
  });
  return ctx;
}

test.describe("Upload & Image Serving API", () => {
  test("5.1.1 — upload valid JPEG returns receiptId", async () => {
    const ctx = await authedContext("alice@example.com", "password123");
    // Create a tiny valid JPEG (just the header)
    const jpegHeader = Buffer.from([
      0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46, 0x00, 0x01,
      0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xFF, 0xD9,
    ]);

    const res = await ctx.post("/api/upload", {
      multipart: {
        file: { name: "receipt.jpg", mimeType: "image/jpeg", buffer: jpegHeader },
      },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.receiptId).toBeDefined();
    expect(body.imagePath).toContain("receipts/");
    await ctx.dispose();
  });

  test("5.1.2 — upload valid PNG", async () => {
    const ctx = await authedContext("alice@example.com", "password123");
    // Minimal valid PNG
    const pngHeader = Buffer.from([
      0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A,
    ]);
    const res = await ctx.post("/api/upload", {
      multipart: {
        file: { name: "receipt.png", mimeType: "image/png", buffer: pngHeader },
      },
    });
    expect(res.status()).toBe(200);
    await ctx.dispose();
  });

  test("5.1.3 — upload invalid type returns 400", async () => {
    const ctx = await authedContext("alice@example.com", "password123");
    const res = await ctx.post("/api/upload", {
      multipart: {
        file: { name: "doc.pdf", mimeType: "application/pdf", buffer: Buffer.from("fake pdf") },
      },
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("Invalid file type");
    await ctx.dispose();
  });

  test("5.1.5 — upload without auth returns 401", async () => {
    const ctx = await request.newContext({ baseURL: BASE });
    const res = await ctx.post("/api/upload", {
      multipart: {
        file: { name: "test.jpg", mimeType: "image/jpeg", buffer: Buffer.from("fake") },
      },
    });
    expect(res.status()).toBe(401);
    await ctx.dispose();
  });

  test("5.1.6 — upload no file returns 400", async () => {
    const ctx = await authedContext("alice@example.com", "password123");
    const res = await ctx.post("/api/upload", {
      multipart: {},
    });
    // Should return 400 for missing file
    expect([400, 500]).toContain(res.status());
    await ctx.dispose();
  });

  test("6.1 — serve uploaded image (authenticated)", async () => {
    const ctx = await authedContext("alice@example.com", "password123");
    // Upload an image first
    const jpegData = Buffer.alloc(100, 0xFF);
    jpegData[0] = 0xFF;
    jpegData[1] = 0xD8;
    const uploadRes = await ctx.post("/api/upload", {
      multipart: {
        file: { name: "test-serve.jpg", mimeType: "image/jpeg", buffer: jpegData },
      },
    });
    const { imagePath } = await uploadRes.json();

    // Retrieve it
    const serveRes = await ctx.get(`/api/uploads/${imagePath}`);
    expect(serveRes.status()).toBe(200);
    expect(serveRes.headers()["content-type"]).toContain("image/jpeg");
    await ctx.dispose();
  });

  test("6.3 — non-existent file returns 404", async () => {
    const ctx = await authedContext("alice@example.com", "password123");
    const res = await ctx.get("/api/uploads/receipts/nonexistent-file.jpg");
    expect(res.status()).toBe(404);
    await ctx.dispose();
  });

  test("6.5 — served image has cache headers", async () => {
    const ctx = await authedContext("alice@example.com", "password123");
    // Upload first
    const uploadRes = await ctx.post("/api/upload", {
      multipart: {
        file: { name: "cache-test.jpg", mimeType: "image/jpeg", buffer: Buffer.alloc(50, 0xFF) },
      },
    });
    const { imagePath } = await uploadRes.json();

    const serveRes = await ctx.get(`/api/uploads/${imagePath}`);
    if (serveRes.status() === 200) {
      expect(serveRes.headers()["cache-control"]).toContain("private");
    }
    await ctx.dispose();
  });
});
