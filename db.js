const crypto = require("crypto");
const { promisify } = require("util");
const { Pool } = require("pg");

const scrypt = promisify(crypto.scrypt);
const SCRYPT = { N: 16384, r: 8, p: 1 };
const INVITE_DAYS = 7;

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function migrate() {
  await pool.query(`
    create table if not exists users (
      id serial primary key,
      email text unique not null,
      name text not null,
      password_hash text not null,
      is_admin boolean not null default false,
      session_version integer not null default 1,
      created_at timestamptz not null default now(),
      last_login_at timestamptz
    );
    create table if not exists invites (
      id serial primary key,
      token_hash text unique not null,
      email text not null,
      is_admin boolean not null default false,
      created_by text,
      created_at timestamptz not null default now(),
      expires_at timestamptz not null,
      used_at timestamptz
    );
  `);
}

const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(password, salt, 64, SCRYPT);
  return `scrypt$${salt.toString("hex")}$${hash.toString("hex")}`;
}

async function checkPassword(password, stored) {
  const [, saltHex, hashHex] = (stored || "scrypt$00$00").split("$");
  const expected = Buffer.from(hashHex, "hex");
  const actual = await scrypt(password, Buffer.from(saltHex, "hex"), 64, SCRYPT);
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

// Returns the raw token; only its hash is stored, so a link can't be recovered from the database.
async function createInvite(email, { isAdmin = false, createdBy = null, token = crypto.randomBytes(32).toString("base64url") } = {}) {
  await pool.query(
    `insert into invites (token_hash, email, is_admin, created_by, expires_at)
     values ($1, $2, $3, $4, now() + ($5 || ' days')::interval)
     on conflict (token_hash) do nothing`,
    [sha256(token), email.toLowerCase(), isAdmin, createdBy, String(INVITE_DAYS)]
  );
  return token;
}

async function findInvite(token) {
  const { rows } = await pool.query(
    `select * from invites where token_hash = $1 and used_at is null and expires_at > now()`,
    [sha256(token)]
  );
  return rows[0] || null;
}

// Uses the invite and sets the password in one transaction. Also serves as a password reset
// for an existing user, which signs them out everywhere else.
async function acceptInvite(token, name, password) {
  const passwordHash = await hashPassword(password);
  const client = await pool.connect();
  try {
    await client.query("begin");
    const { rows: inv } = await client.query(
      `update invites set used_at = now()
       where token_hash = $1 and used_at is null and expires_at > now() returning *`,
      [sha256(token)]
    );
    if (!inv.length) {
      await client.query("rollback");
      return null;
    }
    const { rows } = await client.query(
      `insert into users (email, name, password_hash, is_admin) values ($1, $2, $3, $4)
       on conflict (email) do update set
         name = excluded.name,
         password_hash = excluded.password_hash,
         is_admin = users.is_admin or excluded.is_admin,
         session_version = users.session_version + 1
       returning *`,
      [inv[0].email, name, passwordHash, inv[0].is_admin]
    );
    await client.query("commit");
    return rows[0];
  } catch (err) {
    await client.query("rollback");
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { pool, migrate, createInvite, findInvite, acceptInvite, checkPassword, INVITE_DAYS };
