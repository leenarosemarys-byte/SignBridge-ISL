// Usage: node make-admin.js someone@example.com
// Marks that account as an admin so they can use admin.html to manage
// the HamNoSys sign database.

const fs = require("fs");
const path = require("path");

const USERS_FILE = path.join(__dirname, "users.json");
const email = process.argv[2];

if (!email) {
  console.error("Usage: node make-admin.js <email>");
  process.exit(1);
}

const users = JSON.parse(fs.readFileSync(USERS_FILE, "utf-8"));
const user = users.find(u => u.email.toLowerCase() === email.toLowerCase());

if (!user) {
  console.error(`No account found with email "${email}".`);
  process.exit(1);
}

user.isAdmin = true;
fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
console.log(`"${user.name}" (${user.email}) is now an admin.`);
