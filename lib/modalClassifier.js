// ---------------------------------------------------------------
// Modal Verb Classifier -- the project's actual AIML component
// ---------------------------------------------------------------
// Everything else in signEngine.js (stopword removal by POS category,
// pronoun case-folding, lemmatization) is RULE-BASED NLP: a human
// wrote down the rule, the code just applies it. This file is
// different on purpose -- it's a small Naive Bayes text classifier
// that LEARNS, from labeled examples, whether a modal verb ("will",
// "could", "would", "should"...) should be kept as a sign or dropped,
// instead of a human hand-writing that rule.
//
// Why Naive Bayes instead of a neural net: the training set here is
// small (dozens to low hundreds of hand-labeled examples, realistic
// for a student project with no massive corpus). A neural net would
// overfit badly on that little data. Naive Bayes is the standard,
// defensible choice for small labeled text-classification problems,
// and it's easy to explain and justify in a report.
//
// IMPORTANT: the seed examples in data/modalTrainingData.json are
// PLACEHOLDERS to make the pipeline demonstrably work end-to-end.
// They are not verified ISL linguistics ground truth. Real accuracy
// depends on a native ISL signer (or your project guide) labeling
// real examples through the admin panel -- see /api/admin/modal-examples.
// ---------------------------------------------------------------

const fs = require("fs");
const path = require("path");

const EXAMPLES_FILE = path.join(__dirname, "..", "data", "modalTrainingData.json");
const LABELS = ["keep", "drop"];

// Below this many total examples, there isn't enough data to trust a
// trained decision -- fall back to the old safe default (always keep
// the modal) rather than let the model guess wildly on 2-3 examples.
const MIN_EXAMPLES_TO_TRUST_MODEL = 6;

// --- Flat-file "database" of labeled examples (same pattern as
// users.json / signs.json elsewhere in this project) ---
function loadExamples() {
  if (!fs.existsSync(EXAMPLES_FILE)) {
    fs.writeFileSync(EXAMPLES_FILE, "[]");
  }
  return JSON.parse(fs.readFileSync(EXAMPLES_FILE, "utf-8"));
}

function saveExamples(examples) {
  fs.writeFileSync(EXAMPLES_FILE, JSON.stringify(examples, null, 2));
}

function listExamples() {
  return loadExamples();
}

function addExample({ sentence, modal, label }) {
  const cleanSentence = String(sentence || "").trim();
  const cleanModal = String(modal || "").trim().toLowerCase();
  if (!cleanSentence) throw new Error("A sentence is required.");
  if (!cleanModal) throw new Error("Which modal word this example is about is required.");
  if (!LABELS.includes(label)) throw new Error('Label must be "keep" or "drop".');

  const examples = loadExamples();
  const entry = {
    id: `modal-${Date.now().toString(36)}`,
    sentence: cleanSentence,
    modal: cleanModal,
    label
  };
  examples.push(entry);
  saveExamples(examples);
  return entry;
}

function deleteExample(id) {
  const examples = loadExamples();
  const next = examples.filter(e => e.id !== id);
  if (next.length === examples.length) throw new Error("Example not found.");
  saveExamples(next);
}

// --- Feature extraction ---
// Turns a sentence into a bag of "tokens" the classifier can weigh.
// Alongside plain words, a few engineered signals are included as
// pseudo-tokens -- these aren't hardcoded keep/drop rules, they're
// just features the model is free to learn a weight for (it might
// learn "__isquestion__ strongly predicts keep", or it might not,
// depending entirely on the labeled examples it's trained on).
function extractTokens(sentence, modal) {
  const lower = String(sentence || "").toLowerCase();
  const tokens = lower
    .replace(/[^\w\s?']/g, " ")
    .split(/\s+/)
    .filter(Boolean);

  const features = tokens.slice();
  if (/\?/.test(sentence || "")) features.push("__isquestion__");
  if (/\bnot\b|n't\b/.test(lower)) features.push("__hasnegation__");
  if (modal) features.push(`__modal_${modal.toLowerCase()}__`);

  return features;
}

// --- Naive Bayes training + classification ---
function trainModel(examples) {
  const classCounts = { keep: 0, drop: 0 };
  const wordCounts = { keep: {}, drop: {} };
  const classTotalWords = { keep: 0, drop: 0 };
  const vocab = new Set();

  examples.forEach(ex => {
    if (!LABELS.includes(ex.label)) return;
    classCounts[ex.label]++;
    const features = extractTokens(ex.sentence, ex.modal);
    features.forEach(f => {
      vocab.add(f);
      wordCounts[ex.label][f] = (wordCounts[ex.label][f] || 0) + 1;
      classTotalWords[ex.label]++;
    });
  });

  return {
    classCounts,
    wordCounts,
    classTotalWords,
    vocabSize: vocab.size,
    totalExamples: examples.length
  };
}

// Returns "keep" or "drop". Falls back to "keep" (the old safe
// default) if there isn't enough labeled data yet to trust a
// trained decision.
function classifyModal(sentence, modal) {
  const examples = loadExamples();
  const haveEnoughPerClass =
    examples.filter(e => e.label === "keep").length >= 2 &&
    examples.filter(e => e.label === "drop").length >= 2;

  if (examples.length < MIN_EXAMPLES_TO_TRUST_MODEL || !haveEnoughPerClass) {
    return "keep"; // not enough training data yet -- safe default
  }

  const model = trainModel(examples);
  const features = extractTokens(sentence, modal);

  let best = "keep";
  let bestScore = -Infinity;

  LABELS.forEach(label => {
    const prior = Math.log((model.classCounts[label] || 0.5) / model.totalExamples);
    let score = prior;
    features.forEach(f => {
      const count = (model.wordCounts[label][f] || 0) + 1; // Laplace smoothing
      const denom = model.classTotalWords[label] + model.vocabSize;
      score += Math.log(count / denom);
    });
    if (score > bestScore) {
      bestScore = score;
      best = label;
    }
  });

  return best;
}

function modelStatus() {
  const examples = loadExamples();
  const keep = examples.filter(e => e.label === "keep").length;
  const drop = examples.filter(e => e.label === "drop").length;
  return {
    totalExamples: examples.length,
    keep,
    drop,
    isTrusted: examples.length >= MIN_EXAMPLES_TO_TRUST_MODEL && keep >= 2 && drop >= 2
  };
}

module.exports = {
  listExamples,
  addExample,
  deleteExample,
  classifyModal,
  modelStatus
};
