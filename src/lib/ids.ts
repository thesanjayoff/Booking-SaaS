import { randomBytes } from "node:crypto";

/** 72 bits of randomness, URL-safe. Booking ids are unguessable (they gate the public confirmation page together with a token). */
export function newId(): string {
  return randomBytes(9).toString("base64url");
}
