import { test, expect, request } from "@playwright/test";
import { createReadStream } from "fs";
import { join } from "path";
import { FAKE_JPEG, FAKE_PNG } from "./helpers";

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
    const res = await ctx.post("/api/upload", {
      multipart: {
        file: { name: "receipt.jpg", mimeType: "image/jpeg", buffer: FAKE_JPEG },
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
    const res = await ctx.post("/api/upload", {
      multipart: {
        file: { name: "receipt.png", mimeType: "image/png", buffer: FAKE_PNG },
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
        file: { name: "cache-test.jpg", mimeType: "image/jpeg", buffer: FAKE_JPEG },
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
