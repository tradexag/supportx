import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { many, one, type Db, type Queryable } from "../storage/db.ts";
import { ServiceError, type Actor, type Role } from "./context.ts";

const scryptAsync = promisify(scrypt) as (password: string, salt: Buffer, keylen: number) => Promise<Buffer>;
const SESSION_DAYS = 7;

export async function hashPassword(password: string): Promise<string> {
  if (password.length < 10) throw new ServiceError(400, "WEAK_PASSWORD", "Das Passwort muss mindestens 10 Zeichen lang sein.");
  const salt = randomBytes(16);
  const key = await scryptAsync(password, salt, 64);
  return `scrypt$${salt.toString("base64")}$${key.toString("base64")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, salt, hash] = stored.split("$");
  if (scheme !== "scrypt" || !salt || !hash) return false;
  const expected = Buffer.from(hash, "base64");
  const actual = await scryptAsync(password, Buffer.from(salt, "base64"), expected.length);
  return timingSafeEqual(actual, expected);
}

const tokenHash = (token: string) => createHash("sha256").update(token).digest("hex");

export async function createUser(q: Queryable, input: { email: string; displayName: string; password: string }): Promise<string> {
  const row = await one<{ id: string }>(
    q,
    "INSERT INTO users (email, display_name, password_hash) VALUES ($1, $2, $3) RETURNING id",
    [input.email.trim().toLowerCase(), input.displayName.trim(), await hashPassword(input.password)],
  );
  return row!.id;
}

export async function login(db: Db, email: string, password: string): Promise<{ token: string; userId: string }> {
  const user = await one<{ id: string; password_hash: string }>(db, "SELECT id, password_hash FROM users WHERE email = $1", [email.trim().toLowerCase()]);
  // Same work whether or not the user exists.
  const ok = user ? await verifyPassword(password, user.password_hash) : (await verifyPassword(password, "scrypt$AAAAAAAAAAAAAAAAAAAAAA==$" + "A".repeat(88)), false);
  if (!user || !ok) throw new ServiceError(401, "LOGIN_FAILED", "E-Mail oder Passwort falsch.");
  const token = randomBytes(32).toString("base64url");
  await db.query("INSERT INTO user_sessions (token_hash, user_id, expires_at) VALUES ($1, $2, now() + ($3::int * interval '1 day'))", [tokenHash(token), user.id, SESSION_DAYS]);
  return { token, userId: user.id };
}

/**
 * Own password change: the old password must match, and every other session of
 * the user ends, so a password that leaked stops working everywhere at once.
 */
export async function changePassword(db: Db, userId: string, currentToken: string, oldPassword: string, newPassword: string): Promise<void> {
  const user = await one<{ password_hash: string }>(db, "SELECT password_hash FROM users WHERE id = $1", [userId]);
  if (!user || !(await verifyPassword(oldPassword, user.password_hash))) throw new ServiceError(400, "WRONG_PASSWORD", "Das bisherige Passwort stimmt nicht.");
  if (oldPassword === newPassword) throw new ServiceError(400, "SAME_PASSWORD", "Das neue Passwort muss sich vom bisherigen unterscheiden.");
  const hash = await hashPassword(newPassword);
  await db.query("UPDATE users SET password_hash = $1 WHERE id = $2", [hash, userId]);
  await db.query("DELETE FROM user_sessions WHERE user_id = $1 AND token_hash <> $2", [userId, tokenHash(currentToken)]);
}

export async function logout(db: Db, token: string): Promise<void> {
  await db.query("DELETE FROM user_sessions WHERE token_hash = $1", [tokenHash(token)]);
}

export async function userForSession(db: Db, token: string | undefined): Promise<{ id: string; email: string; display_name: string } | null> {
  if (!token) return null;
  return one(db, "SELECT u.id, u.email, u.display_name FROM user_sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = $1 AND s.expires_at > now()", [tokenHash(token)]);
}

export async function workspacesFor(db: Db, userId: string): Promise<Array<{ id: string; name: string; role: Role }>> {
  return many(db, "SELECT w.id, w.name, m.role FROM memberships m JOIN workspaces w ON w.id = m.workspace_id WHERE m.user_id = $1 ORDER BY w.name", [userId]);
}

/**
 * Workspace scope always comes from a server-side membership lookup, never from
 * the client-supplied id alone. Non-members get 404 (no existence leak).
 */
export async function actorFor(db: Db, userId: string, workspaceId: string): Promise<Actor> {
  if (!/^[0-9a-f-]{36}$/i.test(workspaceId)) throw new ServiceError(404, "NOT_FOUND", "Arbeitsbereich nicht gefunden.");
  const m = await one<{ role: Role }>(db, "SELECT role FROM memberships WHERE user_id = $1 AND workspace_id = $2", [userId, workspaceId]);
  if (!m) throw new ServiceError(404, "NOT_FOUND", "Arbeitsbereich nicht gefunden.");
  return { type: "user", userId, workspaceId, role: m.role };
}
