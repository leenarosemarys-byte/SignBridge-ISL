// ---------------------------------------------------------------
// Similarity Matcher -- second AIML component
// ---------------------------------------------------------------
// The modal classifier (modalClassifier.js) is a Naive Bayes text
// CLASSIFIER: given a sentence, predict a keep/drop label.
//
// This file is a different ML technique on purpose: a VECTOR SPACE
// MODEL. Every word is represented as a vector of character
// trigrams (3-letter chunks), and cosine similarity between vectors
// finds the closest match. This is the same family of technique
// search engines and spell-checkers use (bag-of-n-grams + cosine
// similarity), applied here to find an existing sign for a word
// that has no exact entry in the database.
//
// What this catches that the fixed LEMMA_MAP in signEngine.js
// doesn't: unanticipated inflections and small typos. E.g. "markets"
// has no LEMMA_MAP entry, but its trigram vector is very close to
// "market"'s, so it resolves to that sign instead of being spelled
// out letter by letter.
//
// What this is NOT: true semantic understanding. It's LEXICAL
// (spelling-pattern) similarity, not meaning-based similarity --
// "purchase" will NOT match "market" here, because they don't share
// character patterns, even though they're related in meaning. Real
// semantic matching would need pretrained word embeddings (a large
// downloaded model file), which is why this project uses the
// lighter, fully self-contained technique instead. Worth stating
// plainly in a report rather than overclaiming "semantic AI."
// ---------------------------------------------------------------

// How close a match has to be (0-1 cosine similarity) before it's
// trusted over just letter-spelling the original word. Tuned
// conservatively -- a wrong "confident" match is worse than falling
// back to spelling, since spelling is at least honest about not
// knowing the word.
const SIMILARITY_THRESHOLD = 0.5;

// Pads short words so trigram extraction still captures word
// boundaries (e.g. "cat" -> "##cat##" -> ##c, #ca, cat, at#, t##).
function toTrigramVector(word) {
  const padded = `##${word}##`;
  const vector = {};
  for (let i = 0; i < padded.length - 2; i++) {
    const gram = padded.slice(i, i + 3);
    vector[gram] = (vector[gram] || 0) + 1;
  }
  return vector;
}

function cosineSimilarity(vecA, vecB) {
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (const key in vecA) {
    magA += vecA[key] * vecA[key];
    if (vecB[key]) dot += vecA[key] * vecB[key];
  }
  for (const key in vecB) {
    magB += vecB[key] * vecB[key];
  }
  if (magA === 0 || magB === 0) return 0;
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

// --- Damerau-Levenshtein edit distance ---
// Trigram cosine similarity is good at catching typos in LONGER words
// (most trigrams survive one small error), but breaks down on short
// words -- a 3-letter word like "she" only has 5 trigrams total, so
// scrambling it changes almost the whole vector. Edit distance (with
// transposition counted as a single edit, not two substitutions) is
// the standard fix for exactly that case: "seh"/"she" and "hre"/"her"
// are each one transposition away, distance 1, even though their
// trigram overlap is nearly zero.
function damerauLevenshtein(a, b) {
  const al = a.length;
  const bl = b.length;
  const d = [];
  for (let i = 0; i <= al; i++) d[i] = [i];
  for (let j = 0; j <= bl; j++) d[0][j] = j;

  for (let i = 1; i <= al; i++) {
    for (let j = 1; j <= bl; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(
        d[i - 1][j] + 1,     // deletion
        d[i][j - 1] + 1,     // insertion
        d[i - 1][j - 1] + cost // substitution
      );
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + cost); // adjacent transposition
      }
    }
  }
  return d[al][bl];
}

// Finds the closest word in `vocabulary` (an iterable of lowercase
// words) to `word`, using two techniques: trigram cosine similarity
// (strong on longer words) and edit distance (strong on short words).
// Returns { match, score, method } or null if neither technique
// clears its threshold.
function findClosestWord(word, vocabulary) {
  if (!word || word.length < 2) return null;

  const target = toTrigramVector(word);
  let bestTrigram = null;
  let bestTrigramScore = 0;
  let bestEdit = null;

  for (const candidate of vocabulary) {
    if (candidate === word) continue; // exact matches are handled elsewhere, not here

    const trigramScore = cosineSimilarity(target, toTrigramVector(candidate));
    if (trigramScore > bestTrigramScore) {
      bestTrigramScore = trigramScore;
      bestTrigram = candidate;
    }

    // Edit distance: only trust it as a tight, near-exact match --
    // 1 edit for short/medium words, 2 only once the word is long
    // enough that 2 edits still means "almost the same word" rather
    // than "a different word that happens to be nearby". At 5 letters,
    // 2 edits is too loose -- e.g. "still" is 2 edits from "kill"
    // (drop "s", "t"->"k") despite being unrelated in meaning. Words
    // shorter than 3 letters are excluded entirely: at that length,
    // "1 edit away" includes too many genuinely unrelated words
    // (e.g. "to" is 1 edit from "go") to be trustworthy.
    const maxAllowedDist = word.length <= 5 ? 1 : 2;
    if (word.length >= 3 && Math.abs(word.length - candidate.length) <= maxAllowedDist) {
      const dist = damerauLevenshtein(word, candidate);
      if (dist <= maxAllowedDist && (!bestEdit || dist < bestEdit.distance)) {
        bestEdit = { match: candidate, distance: dist };
      }
    }
  }

  if (bestTrigram && bestTrigramScore >= SIMILARITY_THRESHOLD - 1e-9) {
    return { match: bestTrigram, score: bestTrigramScore, method: "trigram" };
  }
  if (bestEdit) {
    return { match: bestEdit.match, score: bestEdit.distance, method: "edit-distance" };
  }
  return null;
}

module.exports = { findClosestWord, cosineSimilarity, toTrigramVector, damerauLevenshtein, SIMILARITY_THRESHOLD };
