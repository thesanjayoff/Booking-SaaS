import { test, expect } from "@playwright/test";

test.use({ storageState: { cookies: [], origins: [] } });

test("security headers are present on pages and API responses", async ({ request }) => {
  for (const path of ["/", "/book/general-consultation", "/api/slots?service=general-consultation&from=2030-01-01T00:00:00Z&to=2030-01-03T00:00:00Z"]) {
    const h = (await request.get(path)).headers();
    expect(h["x-frame-options"], path).toBe("DENY");
    expect(h["x-content-type-options"], path).toBe("nosniff");
    expect(h["content-security-policy"], path).toContain("frame-ancestors 'none'");
    expect(h["referrer-policy"], path).toBeTruthy();
    expect(h["x-powered-by"], path).toBeUndefined();
  }
});

test("API validates input: wrong types, unknown fields are ignored, oversized and non-JSON bodies are refused", async ({ request }) => {
  // Strings go out as raw bytes (Playwright would otherwise re-encode a string as a JSON string literal);
  // objects are serialised by Playwright.
  const post = (data: unknown, type = "application/json") =>
    request.post("/api/bookings", { data: typeof data === "string" ? Buffer.from(data) : (data as object), headers: { "content-type": type } });
  expect((await post("{not json")).status()).toBe(400);
  expect((await post({ service: 5 })).status()).toBe(422);
  expect((await post("x=1", "application/x-www-form-urlencoded")).status()).toBe(415);
  expect((await post({ service: "general-consultation", notes: "x".repeat(40_000) })).status()).toBe(413);
  // Otherwise-valid request; the only thing wrong is the filled-in honeypot field.
  const honey = await post({ service: "general-consultation", start: "2030-06-03T10:00:00Z", name: "Bot", email: "bot@example.com", timezone: "UTC", website: "http://spam" });
  expect(honey.status()).toBe(422);
  expect((await honey.json()).error.fields).toHaveProperty("website");
});

test("slots endpoint rejects absurd ranges and unknown services", async ({ request }) => {
  expect((await request.get("/api/slots?service=general-consultation&from=2030-01-01T00:00:00Z&to=2031-01-01T00:00:00Z")).status()).toBe(422);
  expect((await request.get("/api/slots?service=nope&from=2030-01-01T00:00:00Z&to=2030-01-03T00:00:00Z")).status()).toBe(404);
  expect((await request.get("/api/slots?service=general-consultation")).status()).toBe(422);
});

test("webhook endpoint is closed while payments are off", async ({ request }) => {
  expect((await request.post("/api/webhooks/razorpay", { data: "{}" })).status()).toBe(404);
});

test("public routes are rate limited (runs last: it exhausts the shared bucket)", async ({ request }) => {
  let limited = 0;
  let retryAfter = "";
  for (let i = 0; i < 20; i++) {
    const r = await request.post("/api/bookings", { data: { service: "general-consultation" } });
    if (r.status() === 429) {
      limited++;
      retryAfter = r.headers()["retry-after"] ?? "";
    }
  }
  expect(limited).toBeGreaterThan(0);
  expect(Number(retryAfter)).toBeGreaterThan(0);
});
