// Recovery when no admin can log in: sets a new password for an account and signs out its sessions.
//   npm run reset-password -- <email> [--admin]
// The new password is read from NX_NEW_PASSWORD, or generated and printed once.
import { randomBytes } from "node:crypto";
import { loadConfig } from "../config.js";
import { createPool } from "../db/pool.js";
import { AuditRepo } from "../repos/settings.js";
import { SessionsRepo, UsersRepo } from "../repos/users.js";
import { hashPassword, validatePasswordStrength } from "./password.js";

const [email, ...flags] = process.argv.slice(2);
if (!email) {
  console.error("usage: reset-password <email> [--admin]");
  process.exit(2);
}
const password =
  process.env.NX_NEW_PASSWORD || randomBytes(12).toString("base64url");
const weak = validatePasswordStrength(password);
if (weak) {
  console.error(weak);
  process.exit(2);
}

const pool = createPool(loadConfig().databaseUrl, 1);
try {
  const users = new UsersRepo(pool);
  const u = await users.byEmail(email);
  if (!u) {
    console.error(`no account with email ${email}`);
    process.exitCode = 1;
  } else {
    await users.update(u.id, {
      passwordHash: await hashPassword(password),
      disabled: false,
      ...(flags.includes("--admin") ? { role: "admin" as const } : {}),
    });
    await new SessionsRepo(pool).destroyAllForUser(u.id);
    await new AuditRepo(pool).log({
      userId: u.id,
      action: "cli.reset_password",
      target: u.id,
      data: { admin: flags.includes("--admin") },
    });
    console.log(
      process.env.NX_NEW_PASSWORD
        ? `password updated for ${u.email}`
        : `new password for ${u.email}: ${password}`,
    );
  }
} finally {
  await pool.end();
}
