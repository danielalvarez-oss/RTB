// Creates an invite link from the command line, e.g. for the first admin:
//   railway ssh -- node invite.js someone@junglecreations.com --admin
const db = require("./db");

const ALLOWED_DOMAIN = (process.env.ALLOWED_DOMAIN || "junglecreations.com").toLowerCase();
const BASE_URL = process.env.BASE_URL || `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`;

(async () => {
  const email = (process.argv[2] || "").trim().toLowerCase();
  if (!email.endsWith(`@${ALLOWED_DOMAIN}`)) {
    console.error(`Usage: node invite.js name@${ALLOWED_DOMAIN} [--admin]`);
    process.exit(1);
  }
  await db.migrate();
  const token = await db.createInvite(email, { isAdmin: process.argv.includes("--admin"), createdBy: "command line" });
  console.log(`${BASE_URL}/invite/${token}`);
  await db.pool.end();
})().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
