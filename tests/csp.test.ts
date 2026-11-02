import { describe, it, expect } from "vitest";
import { buildCsp, newNonce } from "@/lib/csp";

const directive = (csp: string, name: string) => csp.split("; ").find((d) => d.startsWith(name + " ")) ?? "";

describe("Content-Security-Policy", () => {
  it("scripts need the per-request nonce: no unsafe-inline, no unsafe-eval in production", () => {
    const csp = buildCsp("abc123==", false);
    const script = directive(csp, "script-src");
    expect(script).toContain("'nonce-abc123=='");
    expect(script).not.toContain("'unsafe-inline'");
    expect(script).not.toContain("'unsafe-eval'");
    expect(script).not.toContain("*");
  });

  it("allows eval in development only (React uses it to rebuild stack traces)", () => {
    expect(directive(buildCsp("n", true), "script-src")).toContain("'unsafe-eval'");
    expect(directive(buildCsp("n", false), "script-src")).not.toContain("'unsafe-eval'");
  });

  it("only Razorpay is allowed as a third party for scripts, frames and connections", () => {
    const csp = buildCsp("n", false);
    expect(directive(csp, "script-src")).toContain("https://checkout.razorpay.com");
    expect(directive(csp, "frame-src")).toBe("frame-src https://api.razorpay.com https://checkout.razorpay.com");
    const hosts = (csp.match(/https:\/\/[^\s;]+/g) ?? []).map((h) => new URL(h.replace("*.", "x.")).hostname);
    expect(hosts.every((h) => h.endsWith("razorpay.com"))).toBe(true);
  });

  it("blocks framing, plugins, base-tag and cross-origin form posts", () => {
    const csp = buildCsp("n", false);
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'self'");
    expect(csp).toContain("form-action 'self'");
    expect(directive(csp, "default-src")).toBe("default-src 'self'");
  });

  it("nonces are unique, unguessable-length and CSP-safe base64", () => {
    const seen = new Set(Array.from({ length: 500 }, () => newNonce()));
    expect(seen.size).toBe(500);
    for (const n of seen) {
      expect(n).toMatch(/^[A-Za-z0-9+/]+=*$/);
      expect(atob(n).length).toBe(16); // 128 bits
    }
  });
});
