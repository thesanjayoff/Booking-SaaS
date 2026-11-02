/**
 * Content-Security-Policy. Built per request so every response carries a fresh nonce:
 * inline scripts (Next's bootstrap/hydration data) run only if they carry it, which is what
 * lets script-src drop 'unsafe-inline'. Razorpay Checkout is the only third-party script.
 *
 * style-src keeps 'unsafe-inline' on purpose: React renders inline `style=""` attributes
 * (progress bars, calendar cells) and a nonce does not cover attributes. Script execution
 * is the XSS-relevant part; injected CSS can't run code.
 */
export function buildCsp(nonce: string, dev: boolean): string {
  return [
    "default-src 'self'",
    // React uses eval in development only (to rebuild server stack traces in the browser).
    `script-src 'self' 'nonce-${nonce}' https://checkout.razorpay.com${dev ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: https:",
    "font-src 'self' data:",
    "connect-src 'self' https://*.razorpay.com https://lumberjack.razorpay.com",
    "frame-src https://api.razorpay.com https://checkout.razorpay.com",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
  ].join("; ");
}

/** 128 bits from the platform CSPRNG, base64. Unguessable and unique per request. */
export function newNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes));
}
