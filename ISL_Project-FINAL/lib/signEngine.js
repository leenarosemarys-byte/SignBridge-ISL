// ---------------------------------------------------------------
// Sign Engine
// ---------------------------------------------------------------
// This is the backend brain of the ISL app, matching the intended
// architecture:
//
//   Input sentence -> Parse -> match against HamNoSys database
//   -> HamNoSys extraction -> HamNoSys-to-SiGML conversion -> SiGML
//
// The "database" is data/signs.json, a flat JSON file (same pattern
// as users.json / rooms.json) holding one entry per gloss:
//   { id, gloss, type: "digit"|"alphabet"|"word", hamnosys: [tokens] }
//
// The admin panel (server.js /api/admin/signs routes) edits this
// file directly. Everything in this module re-reads the file each
// call, so admin edits take effect immediately without a restart.
// ---------------------------------------------------------------

const fs = require("fs");
const path = require("path");

// compromise is a self-contained, offline part-of-speech tagger (no
// network calls, no training step). It's used to classify each word
// as a noun/verb/preposition/conjunction/etc so we can drop whole
// GRAMMATICAL CATEGORIES of filler word (any preposition, any
// conjunction, "to be", helper verbs) instead of maintaining a fixed
// list of specific words. If it isn't installed yet (npm install
// hasn't been run), everything below falls back to the old fixed
// list so the app still works, just less smartly.
let nlp = null;
try {
  nlp = require("compromise");
} catch (e) {
  nlp = null;
}

const SIGNS_FILE = path.join(__dirname, "..", "data", "signs.json");
const modalClassifier = require("./modalClassifier");
const similarityMatcher = require("./similarityMatcher");

const wordForDigit = {
  "0": "zero", "1": "one", "2": "two", "3": "three", "4": "four",
  "5": "five", "6": "six", "7": "seven", "8": "eight", "9": "nine"
};

// --- Database load/save (flat-file, same style as users.json) ---
function loadSigns() {
  if (!fs.existsSync(SIGNS_FILE)) {
    fs.writeFileSync(SIGNS_FILE, "[]");
  }
  const raw = fs.readFileSync(SIGNS_FILE, "utf-8");
  return JSON.parse(raw);
}

function saveSigns(signs) {
  fs.writeFileSync(SIGNS_FILE, JSON.stringify(signs, null, 2));
}

// Build fast lookup structures from the raw list.
function buildIndex(signs) {
  const byGloss = new Map();
  const letters = new Set();
  const words = new Set();
  signs.forEach(s => {
    const key = String(s.gloss).toLowerCase();
    byGloss.set(key, s);
    if (s.type === "alphabet") letters.add(key);
    if (s.type === "word") words.add(key);
  });
  return { byGloss, letters, words };
}

// --- Sentence parsing: English text -> ordered list of glosses ---
// Same scope/behavior as the original client-side parser: strips
// filler/function words, lemmatizes common inflected forms, expands
// digit strings, and falls back to letter-spelling for unknown words.
//
// Filler-word removal now works two ways:
//
//  1. PREFERRED (compromise installed): tag every word's part of
//     speech, then drop it if its grammatical CATEGORY is one that
//     carries no independent sign -- conjunctions ("and", "or"),
//     prepositions ("to", "of", "with", "at"...), articles ("a",
//     "an", "the"), "to be" (is/am/are/was/were), and helper verbs
//     (has/have/had/do/does/did). This generalizes to any sentence,
//     not just words someone remembered to add to a list.
//
//     Modal verbs (will/can/would/should/must...) are handled by a
//     small trained classifier (lib/modalClassifier.js) instead of a
//     fixed rule -- see that file for why. Until it has enough
//     labeled examples to trust, it defaults to keeping the modal
//     (falls through to letter-spelling if there's no sign for it),
//     same as the old behavior.
//
//     Pronouns ("she", "her", "your") are always kept (never dropped
//     as filler) for a similar reason: dropping them would lose who
//     the sentence is about, so they're signed as a word if the
//     database has one, or letter-spelled if not.
//
//  2. FALLBACK (compromise not installed yet -- e.g. npm install
//     hasn't been run): the original fixed word list. Less smart
//     (only catches words explicitly listed) but keeps the app
//     working with zero dependencies.

const LEGACY_AUX_STOPWORDS = new Set([
  "is", "am", "are", "was", "were", "be", "been", "being",
  "a", "an", "the",
  "do", "does", "did",
  "has", "have", "had"
]);

// Grammatical categories to drop when compromise's tags include them.
// NOTE: compromise tags "the"/"a"/"an" as "Determiner" -- it does NOT
// use an "Article" tag at all, so the old DROP_TAGS list (which only
// had "Article") never actually caught them. They fell through to the
// exact-match/fuzzy-match pipeline below, where "the" is one edit
// (insert "y") from "they" -- close enough to pass the edit-distance
// check -- so every "the" was silently signed as "they" instead of
// being dropped as filler.
const DROP_TAGS = new Set(["Conjunction", "Preposition", "Article", "Determiner", "Copula", "Auxiliary"]);

// "Determiner" also covers demonstratives (this/that/these/those),
// which compromise tags identically to "the"/"a"/"an" -- but unlike
// articles, these carry real reference ("discuss THAT with her") and
// have an actual sign in the database. Drop the tag category as a
// whole, but keep this specific handful of words out of it.
const DETERMINER_KEEP_WORDS = new Set(["this", "that", "these", "those"]);

function shouldDropByTags(tags, word) {
  const tagSet = new Set(tags || []);
  if (tagSet.has("Modal")) return false; // keep modals -- see note above
  if (tagSet.has("Determiner") && DETERMINER_KEEP_WORDS.has(String(word || "").toLowerCase())) {
    return false; // demonstrative, not a filler article -- keep it
  }
  for (const tag of DROP_TAGS) {
    if (tagSet.has(tag)) return true;
  }
  return false;
}

// Runs compromise over the raw sentence and returns each word in
// order with its POS tags, e.g. [{ text: "goes", tags: ["Verb", ...] }].
// Returns null (triggering the fallback path) if compromise isn't
// installed or tagging fails for any reason.
function tagWords(text) {
  if (!nlp) return null;
  try {
    const sentences = nlp(text || "").json();
    const flat = [];
    sentences.forEach(sentence => {
      (sentence.terms || []).forEach(term => {
        flat.push({ text: String(term.text || ""), tags: term.tags || [] });
      });
    });
    return flat;
  } catch (e) {
    return null;
  }
}

const LEMMA_MAP = {
  "eating": "eat", "eats": "eat", "ate": "eat", "eaten": "eat",
  "sleeping": "sleep", "sleeps": "sleep", "slept": "sleep",
  "thinking": "think", "thinks": "think", "thought": "think",
  "coming": "come", "comes": "come", "came": "come",
  "going": "go", "goes": "go", "went": "go", "gone": "go",
  "saying": "say", "says": "say", "said": "say",
  "picking": "pick", "picks": "pick", "picked": "pick",
  "discussing": "discuss", "discusses": "discuss", "discussed": "discuss",
  "boys": "boy", "girls": "girl", "brothers": "brother", "sisters": "sister",
  "children": "child", "mothers": "mother", "fathers": "father",
  "grandfathers": "grandfather", "grandmothers": "grandmother"
};

function lemmatize(word, index) {
  if (LEMMA_MAP[word]) return LEMMA_MAP[word];
  const suffixRules = [/ing$/, /ed$/, /s$/];
  for (const pattern of suffixRules) {
    if (pattern.test(word)) {
      const stripped = word.replace(pattern, "");
      if (index.words.has(stripped)) return stripped;
    }
  }
  return word;
}

// --- Pronoun case-folding ---
// "she"/"her"/"herself" all point to the same referent in ISL --
// English just spells that referent differently depending on
// grammatical role (subject/object/possessive/reflexive). So if the
// exact typed word has no sign, but its SUBJECT form does ("her" has
// none, "she" does), use that instead of spelling the original out
// letter by letter.
//
// Two layers, so this stays reliable even if compromise's pronoun
// API changes shape: a small guaranteed table first, then
// compromise's general pronoun conjugation as a fallback for cases
// not explicitly listed.
const PRONOUN_SUBJECT_MAP = {
  "her": "she", "him": "he", "them": "they", "us": "we",
  "my": "me", "your": "you", "his": "he", "their": "they", "our": "we",
  "herself": "she", "himself": "he", "themselves": "they",
  "myself": "me", "yourself": "you", "ourselves": "we"
};

function pronounToSubjectForm(word) {
  if (PRONOUN_SUBJECT_MAP[word]) return PRONOUN_SUBJECT_MAP[word];
  if (!nlp) return null;
  try {
    const out = nlp(word).pronouns().toSubject().text("normal");
    return out ? out.trim().toLowerCase() : null;
  } catch (e) {
    return null;
  }
}

function parseTextToGlosses(text, index) {
  const tagged = tagWords(text);

  let items; // [{ text: cleaned lowercase token, tags: [...] }]
  if (tagged && tagged.length > 0) {
    items = tagged
      .filter(term => !shouldDropByTags(term.tags, term.text))
      .map(term => ({
        text: term.text.toLowerCase().replace(/[^\w]/g, ""),
        tags: term.tags || []
      }))
      .filter(item => item.text.length > 0);
  } else {
    const rawTokens = (text || "").trim().split(/\s+/).filter(Boolean);
    items = rawTokens
      .map(t => t.toLowerCase().replace(/[^\w]/g, ""))
      .filter(t => t.length > 0 && !LEGACY_AUX_STOPWORDS.has(t))
      .map(t => ({ text: t, tags: [] }));
  }

  const glosses = [];
  const nearMatches = []; // { original, matched, score } -- logs when the similarity matcher substituted a sign

  for (const item of items) {
    // Modal verbs ("will", "could", "would", "should"...) are the one
    // category where a fixed rule genuinely isn't enough -- sometimes
    // they carry real meaning (a question, a negation, an emphasis)
    // and sometimes they're just English tense-marking that ISL
    // doesn't need. Ask the trained classifier instead of guessing.
    let isKeptModal = false;
    if (item.tags.includes("Modal")) {
      const decision = modalClassifier.classifyModal(text, item.text);
      if (decision === "drop") continue; // classifier says this one carries no independent meaning here
      // decision === "keep" falls through to the normal lookup below --
      // signed if there's an exact entry, spelled out letter by letter
      // if not. isKeptModal flags it so the fuzzy matcher is skipped
      // below (see note there for why).
      isKeptModal = true;
    }

    let tok = lemmatize(item.text, index);

    // Pronoun case-folding: if the exact word has no sign but its
    // subject form does, use that instead of letter-spelling it.
    // The guaranteed table applies regardless of tagging mode; the
    // broader compromise-based fallback only fires when we trust the
    // POS tag (avoids misfiring on non-pronoun words in fallback mode,
    // where every item.tags is empty).
    const isPronoun = PRONOUN_SUBJECT_MAP[item.text] !== undefined || item.tags.includes("Pronoun");
    if (isPronoun && !index.words.has(tok)) {
      const subjectForm = pronounToSubjectForm(item.text);
      if (subjectForm && index.words.has(subjectForm)) {
        tok = subjectForm;
      }
    }

    const cleaned = tok.replace(/[^\d]/g, "");
    if (cleaned.length > 0) {
      for (const digitChar of cleaned) {
        glosses.push(wordForDigit[digitChar]);
      }
    } else {
      const lower = tok;
      if (Object.values(wordForDigit).includes(lower)) {
        glosses.push(lower);
      } else if (lower.length === 1 && index.letters.has(lower)) {
        glosses.push(lower);
      } else if (lower.length > 1 && index.words.has(lower)) {
        glosses.push(lower);
      } else if (lower.length > 1) {
        if (isKeptModal) {
          // A modal verb the classifier has decided IS meaningful here
          // must never be approximately matched. Fuzzy matching is safe
          // for content words ("markte" is still recognizably "market"
          // if it misses), but a modal is a precise grammatical marker
          // -- a near-miss can flip the meaning entirely (this is
          // exactly what happened with "could" -> "cold": one edit
          // apart, but "possibility" vs "temperature" are not the same
          // thing). Spelling it out honestly is safer than guessing.
          for (const ch of lower) {
            if (index.letters.has(ch)) glosses.push(ch);
          }
        } else {
        // No exact word sign -- before spelling it out letter by
        // letter, try the vector-space + edit-distance matcher: is
        // this word close to something we DO have a sign for, OR
        // close to a pronoun form ("her", "him"...) that resolves to
        // a sign via case-folding? The vocabulary is extended with
        // pronoun surface forms specifically so a typo like "hre"
        // corrects to "her" first, THEN case-folds to "she" -- both
        // steps needed, since "her" itself isn't a database entry.
        const extendedVocab = new Set([...index.words, ...Object.keys(PRONOUN_SUBJECT_MAP)]);
        const nearest = similarityMatcher.findClosestWord(lower, extendedVocab);

        let resolved = null;
        if (nearest) {
          let candidate = nearest.match;
          if (!index.words.has(candidate) && PRONOUN_SUBJECT_MAP[candidate]) {
            const subjectForm = PRONOUN_SUBJECT_MAP[candidate];
            if (index.words.has(subjectForm)) candidate = subjectForm;
          }
          // Only accept it if this actually resolves to a real sign --
          // a pronoun-key match (e.g. "him" -> "his") is worthless if
          // "his"/"he" has no database entry either. Better to fall
          // back to letter-spelling than push a gloss with no sign.
          if (index.words.has(candidate)) resolved = candidate;
        }

        if (resolved) {
          glosses.push(resolved);
          nearMatches.push({
            original: lower,
            matched: resolved,
            score: Number(nearest.score.toFixed(3)),
            method: nearest.method
          });
        } else {
          for (const ch of lower) {
            if (index.letters.has(ch)) glosses.push(ch);
          }
        }
        }
      }
    }
  }

  return { glosses, nearMatches };
}

// --- HamNoSys -> SiGML conversion ---
// This is the "HamNoSys to SiGML Converter" backend block from the
// architecture diagram. Given a gloss's stored HamNoSys token list,
// it builds the same <hns_sign> XML shape the static .sigml files
// used, but generated fresh from the database every time.

function escapeAttr(value) {
  return String(value).replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

function tokensToManualXml(tokens) {
  return tokens.map(t => `      <${t}/>`).join("\n");
}

function buildHnsSignBlock(gloss, tokens) {
  return [
    `  <hns_sign gloss="${escapeAttr(gloss)}">`,
    `    <hamnosys_nonmanual/>`,
    `    <hamnosys_manual>`,
    tokensToManualXml(tokens),
    `    </hamnosys_manual>`,
    `  </hns_sign>`
  ].join("\n");
}

// Convert an ordered gloss list into one combined SiGML document,
// looking up each gloss's HamNoSys tokens in the database (index).
// Returns the glosses that couldn't be resolved so the caller can
// tell the user which words have no sign yet.
function buildCombinedSigml(glossList, index) {
  const blocks = [];
  const unresolved = [];
  const seenCounts = {};

  for (const gloss of glossList) {
    const entry = index.byGloss.get(String(gloss).toLowerCase());
    if (!entry || !Array.isArray(entry.hamnosys) || entry.hamnosys.length === 0) {
      unresolved.push(gloss);
      continue;
    }

    // Give repeated glosses unique labels -- the avatar engine uses
    // the gloss attribute as an internal key and errors on duplicates.
    seenCounts[gloss] = (seenCounts[gloss] || 0) + 1;
    const label = seenCounts[gloss] > 1 ? `${gloss}_${seenCounts[gloss]}` : gloss;

    blocks.push(buildHnsSignBlock(label, entry.hamnosys));
  }

  const sigml = `<?xml version="1.0" encoding="utf-8"?>\n<sigml>\n${blocks.join("\n")}\n</sigml>`;
  return { sigml, unresolved };
}

// Full pipeline: raw text in, {glosses, sigml, unresolved, nearMatches} out.
function generateSignSigml(text) {
  const signs = loadSigns();
  const index = buildIndex(signs);
  const { glosses, nearMatches } = parseTextToGlosses(text, index);
  const { sigml, unresolved } = buildCombinedSigml(glosses, index);
  return { glosses, sigml, unresolved, nearMatches };
}

// Preview conversion for the admin panel: turn a raw comma/newline
// separated token string (or array) into the SiGML block a gloss
// would produce, WITHOUT saving anything -- lets an admin check
// their HamNoSys entry looks right before adding it to the database.
function previewSigml(gloss, hamnosys) {
  const tokens = normalizeTokens(hamnosys);
  if (tokens.length === 0) return "";
  const block = buildHnsSignBlock(gloss || "preview", tokens);
  return `<?xml version="1.0" encoding="utf-8"?>\n<sigml>\n${block}\n</sigml>`;
}

// --- Admin CRUD over the signs database ---

function normalizeTokens(hamnosys) {
  let tokens;
  if (Array.isArray(hamnosys)) {
    tokens = hamnosys;
  } else {
    tokens = String(hamnosys || "").split(/[,\n]/);
  }
  return tokens
    .map(t => String(t).trim())
    .filter(Boolean)
    .map(t => t.replace(/^</, "").replace(/\/?>$/, "")); // tolerate pasted <hamx/> tags
}

function listSigns() {
  return loadSigns();
}

function addSign({ gloss, type, hamnosys }) {
  const cleanGloss = String(gloss || "").trim();
  if (!cleanGloss) throw new Error("Gloss is required.");

  const signs = loadSigns();
  if (signs.some(s => String(s.gloss).toLowerCase() === cleanGloss.toLowerCase())) {
    throw new Error(`A sign for "${cleanGloss}" already exists.`);
  }

  const tokens = normalizeTokens(hamnosys);
  if (tokens.length === 0) throw new Error("At least one HamNoSys token is required.");

  const entry = {
    id: `sign-${Date.now().toString(36)}`,
    gloss: cleanGloss,
    type: type || "word",
    hamnosys: tokens
  };
  signs.push(entry);
  saveSigns(signs);
  return entry;
}

function updateSign(id, { gloss, type, hamnosys }) {
  const signs = loadSigns();
  const idx = signs.findIndex(s => s.id === id);
  if (idx === -1) throw new Error("Sign not found.");

  if (gloss !== undefined && String(gloss).trim()) {
    signs[idx].gloss = String(gloss).trim();
  }
  if (type !== undefined && type) {
    signs[idx].type = type;
  }
  if (hamnosys !== undefined) {
    const tokens = normalizeTokens(hamnosys);
    if (tokens.length === 0) throw new Error("At least one HamNoSys token is required.");
    signs[idx].hamnosys = tokens;
  }

  saveSigns(signs);
  return signs[idx];
}

function deleteSign(id) {
  const signs = loadSigns();
  const next = signs.filter(s => s.id !== id);
  if (next.length === signs.length) throw new Error("Sign not found.");
  saveSigns(next);
}

module.exports = {
  loadSigns,
  saveSigns,
  buildIndex,
  parseTextToGlosses,
  buildCombinedSigml,
  generateSignSigml,
  previewSigml,
  listSigns,
  addSign,
  updateSign,
  deleteSign,
  wordForDigit
};

