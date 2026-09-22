// ---------------------------------------------------------------
// ISL Project backend server
// Handles: serving the website, user signup, login, logout,
// and checking whether someone is currently logged in.
// User data is stored in users.json (a simple flat file "database").
// ---------------------------------------------------------------

const express = require("express");
const session = require("express-session");
const bcrypt = require("bcryptjs");
const fs = require("fs");
const path = require("path");
const signEngine = require("./lib/signEngine");
const modalClassifier = require("./lib/modalClassifier");

const app = express();
const PORT = process.env.PORT || 8080;
const USERS_FILE = path.join(__dirname, "users.json");
const ROOMS_FILE = path.join(__dirname, "rooms.json");

// --- Simple JSON-file "database" helpers ---
function loadUsers() {
  if (!fs.existsSync(USERS_FILE)) {
    fs.writeFileSync(USERS_FILE, "[]");
  }
  const raw = fs.readFileSync(USERS_FILE, "utf-8");
  return JSON.parse(raw);
}

function saveUsers(users) {
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
}

// --- Rooms: pairs up a Hearing user and a Deaf/HoH user in one
// shared conversation, identified by a short room code. Same flat-file
// pattern as users.json, just a different file. ---
function loadRooms() {
  if (!fs.existsSync(ROOMS_FILE)) {
    fs.writeFileSync(ROOMS_FILE, "{}");
  }
  const raw = fs.readFileSync(ROOMS_FILE, "utf-8");
  return JSON.parse(raw);
}

function saveRooms(rooms) {
  fs.writeFileSync(ROOMS_FILE, JSON.stringify(rooms, null, 2));
}

// Excludes visually ambiguous characters (0/O, 1/I) so codes are easy
// to read aloud or type from one screen to another.
function generateRoomCode(rooms) {
  const chars = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  let code;
  do {
    code = "";
    for (let i = 0; i < 6; i++) {
      code += chars[Math.floor(Math.random() * chars.length)];
    }
  } while (rooms[code]); // regenerate on the rare collision
  return code;
}

// --- Middleware ---
app.use(express.json());
app.use(
  session({
    secret: process.env.SESSION_SECRET || "isl-project-secret-change-this-later",
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 1000 * 60 * 60 * 24 } // 1 day
  })
);
app.use(express.static(path.join(__dirname, "public")));

// --- Signup ---
app.post("/api/signup", async (req, res) => {
  const { name, email, password } = req.body;

  if (!name || !email || !password) {
    return res.status(400).json({ error: "Name, email, and password are all required." });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: "Password must be at least 6 characters." });
  }

  const users = loadUsers();
  const existing = users.find(u => u.email.toLowerCase() === email.toLowerCase());
  if (existing) {
    return res.status(409).json({ error: "An account with that email already exists." });
  }

  const passwordHash = await bcrypt.hash(password, 10);
  const newUser = {
    id: Date.now().toString(),
    name,
    email,
    passwordHash
  };
  users.push(newUser);
  saveUsers(users);

  req.session.userId = newUser.id;
  res.json({ success: true, name: newUser.name });
});

// --- Login ---
app.post("/api/login", async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: "Email and password are required." });
  }

  const users = loadUsers();
  const user = users.find(u => u.email.toLowerCase() === email.toLowerCase());
  if (!user) {
    return res.status(401).json({ error: "Incorrect email or password." });
  }

  const passwordMatches = await bcrypt.compare(password, user.passwordHash);
  if (!passwordMatches) {
    return res.status(401).json({ error: "Incorrect email or password." });
  }

  req.session.userId = user.id;
  res.json({ success: true, name: user.name });
});

// --- Logout ---
app.post("/api/logout", (req, res) => {
  req.session.destroy(() => {
    res.json({ success: true });
  });
});

// --- Check current login status ---
app.get("/api/me", (req, res) => {
  if (!req.session.userId) {
    return res.json({ loggedIn: false });
  }
  const users = loadUsers();
  const user = users.find(u => u.id === req.session.userId);
  if (!user) {
    return res.json({ loggedIn: false });
  }
  res.json({ loggedIn: true, name: user.name, email: user.email, isAdmin: !!user.isAdmin });
});

// --- Small helper: require an active login session for an endpoint,
// matching the same login-gating already used for app.html. ---
function requireLogin(req, res, next) {
  if (!req.session.userId) {
    return res.status(401).json({ error: "You must be logged in." });
  }
  next();
}

// --- Require the logged-in user to be an admin (for managing the
// HamNoSys/sign database). Checks users.json fresh each time so a
// promotion/demotion takes effect on the very next request. ---
function requireAdmin(req, res, next) {
  if (!req.session.userId) {
    return res.status(401).json({ error: "You must be logged in." });
  }
  const users = loadUsers();
  const user = users.find(u => u.id === req.session.userId);
  if (!user || !user.isAdmin) {
    return res.status(403).json({ error: "Admin access required." });
  }
  next();
}

// --- Core pipeline endpoint, matching the architecture: Parse ->
// match HamNoSys database -> HamNoSys extraction -> SiGML generation.
// Takes raw text, returns the recognized glosses plus one combined
// SiGML document ready to hand straight to the avatar player. ---
app.post("/api/sign", requireLogin, (req, res) => {
  const { text } = req.body;
  if (!text || !text.trim()) {
    return res.status(400).json({ error: "Text is required." });
  }
  try {
    const { glosses, sigml, unresolved, nearMatches } = signEngine.generateSignSigml(text);
    res.json({ glosses, sigml, unresolved, nearMatches });
  } catch (err) {
    res.status(500).json({ error: "Could not generate signs: " + err.message });
  }
});

// --- Admin: manage the HamNoSys sign database ---

// List every sign in the database.
app.get("/api/admin/signs", requireAdmin, (req, res) => {
  res.json({ signs: signEngine.listSigns() });
});

// Add a new sign: { gloss, type, hamnosys } where hamnosys is either
// an array of tokens or a comma/newline-separated string.
app.post("/api/admin/signs", requireAdmin, (req, res) => {
  try {
    const entry = signEngine.addSign(req.body || {});
    res.json({ success: true, sign: entry });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Edit an existing sign.
app.put("/api/admin/signs/:id", requireAdmin, (req, res) => {
  try {
    const entry = signEngine.updateSign(req.params.id, req.body || {});
    res.json({ success: true, sign: entry });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Delete a sign.
app.delete("/api/admin/signs/:id", requireAdmin, (req, res) => {
  try {
    signEngine.deleteSign(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Live preview: convert a draft gloss + HamNoSys token list into
// SiGML without saving, so an admin can check it before adding it.
app.post("/api/admin/preview", requireAdmin, (req, res) => {
  const { gloss, hamnosys } = req.body || {};
  try {
    const sigml = signEngine.previewSigml(gloss, hamnosys);
    res.json({ sigml });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// --- Admin: manage the modal-verb (will/could/would/should...)
// training examples, and check the classifier's current status. ---

app.get("/api/admin/modal-examples", requireAdmin, (req, res) => {
  res.json({
    examples: modalClassifier.listExamples(),
    status: modalClassifier.modelStatus()
  });
});

// Add a labeled example: { sentence, modal, label: "keep"|"drop" }
app.post("/api/admin/modal-examples", requireAdmin, (req, res) => {
  try {
    const entry = modalClassifier.addExample(req.body || {});
    res.json({ success: true, example: entry, status: modalClassifier.modelStatus() });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete("/api/admin/modal-examples/:id", requireAdmin, (req, res) => {
  try {
    modalClassifier.deleteExample(req.params.id);
    res.json({ success: true, status: modalClassifier.modelStatus() });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});


app.post("/api/rooms", requireLogin, (req, res) => {
  const rooms = loadRooms();
  const code = generateRoomCode(rooms);
  rooms[code] = {
    code,
    createdAt: Date.now(),
    createdBy: req.session.userId,
    messages: []
  };
  saveRooms(rooms);
  res.json({ code });
});

// --- Check whether a room code is valid, before navigating to it. ---
app.get("/api/rooms/:code", requireLogin, (req, res) => {
  const rooms = loadRooms();
  const room = rooms[req.params.code.toUpperCase()];
  if (!room) {
    return res.status(404).json({ error: "No conversation found with that code." });
  }
  res.json({ exists: true, code: room.code });
});

// --- Post a message into a room. `from` is "hearing" or "deaf".
// For hearing -> deaf messages, glosses + SiGML are generated here
// (server-side, via the sign engine) rather than trusting anything
// the client computed, so watch.html can just play back sigml as-is. ---
app.post("/api/rooms/:code/messages", requireLogin, (req, res) => {
  const rooms = loadRooms();
  const room = rooms[req.params.code.toUpperCase()];
  if (!room) {
    return res.status(404).json({ error: "No conversation found with that code." });
  }
  const { from, text } = req.body;
  if (!from || !text) {
    return res.status(400).json({ error: "'from' and 'text' are required." });
  }

  let glosses = null;
  let sigml = null;
  let unresolved = null;
  if (from === "hearing") {
    const result = signEngine.generateSignSigml(text);
    glosses = result.glosses;
    sigml = result.sigml;
    unresolved = result.unresolved;
  }

  room.messages.push({ from, text, glosses, sigml, unresolved, ts: Date.now() });
  saveRooms(rooms);
  res.json({ ok: true, total: room.messages.length, glosses, unresolved });
});

// --- Poll for messages newer than the ones already seen. `since` is
// how many messages the client has already received (a simple count,
// not a timestamp, since messages are only ever appended in order). ---
app.get("/api/rooms/:code/messages", requireLogin, (req, res) => {
  const rooms = loadRooms();
  const room = rooms[req.params.code.toUpperCase()];
  if (!room) {
    return res.status(404).json({ error: "No conversation found with that code." });
  }
  const since = parseInt(req.query.since, 10) || 0;
  res.json({ messages: room.messages.slice(since), total: room.messages.length });
});

app.listen(PORT, () => {
  console.log(`ISL Project server running at http://localhost:${PORT}`);
});
