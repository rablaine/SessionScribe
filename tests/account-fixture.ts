import path from "node:path";
import { Accounts } from "../src/accounts.js";

export const fixtureEmail = "administrator@example.test";
export const fixturePassword = "Fixture-administrator-2026!";

export async function createAccountFixture(directory: string) {
  const accounts = new Accounts({ databasePath: path.join(directory, "accounts.sqlite") });
  const user = await accounts.bootstrapAdministrator(fixtureEmail, fixturePassword);
  return { accounts, user, email: fixtureEmail, password: fixturePassword };
}

export async function loginFixture(baseUrl: string, email = fixtureEmail, password = fixturePassword) {
  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password }),
  });
  if (!response.ok) throw new Error(`Fixture login failed: ${response.status}`);
  const body = await response.json() as { csrfToken: string };
  const cookie = response.headers.get("set-cookie")?.split(";")[0];
  if (!cookie || !body.csrfToken) throw new Error("Fixture session was not issued.");
  return {
    cookie, csrfToken: body.csrfToken,
    headers: { Cookie: cookie, "X-CSRF-Token": body.csrfToken, "Content-Type": "application/json" } as Record<string, string>,
  };
}

export async function authenticatedFetch(
  baseUrl: string,
  credentials: { cookie: string; csrfToken: string; headers?: Record<string, string> },
  pathOrUrl: string,
  options: RequestInit = {},
) {
  const url = new URL(pathOrUrl, `${baseUrl}/`);
  if (url.origin !== new URL(baseUrl).origin) throw new Error("Fixture requests must be same-origin.");
  const headers = new Headers(credentials.headers);
  headers.set("Cookie", credentials.cookie);
  headers.set("X-CSRF-Token", credentials.csrfToken);
  if (options.body instanceof FormData) headers.delete("Content-Type");
  new Headers(options.headers).forEach((value, key) => headers.set(key, value));
  return fetch(url, { ...options, headers });
}
