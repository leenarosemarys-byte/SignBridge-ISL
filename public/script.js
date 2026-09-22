// ---------------------------------------------------------------
// ISL Web App - core logic
// ---------------------------------------------------------------
// This does 2 jobs on the client side now (the heavy lifting -- text
// parsing, HamNoSys database lookup, and HamNoSys-to-SiGML conversion
// -- all happens on the backend, see lib/signEngine.js):
//   1. Send typed or spoken input text to POST /api/sign
//   2. Feed the SiGML that comes back into the embedded avatar iframe,
//      then trigger its "Play SiGML Text" button automatically.
// ---------------------------------------------------------------

const statusEl = document.getElementById("statusMsg");
const inputEl = document.getElementById("userInput");
const iframe = document.getElementById("avatarFrame");
const textOnlyBox = document.getElementById("textOnlyBox");
const glossBox = document.getElementById("glossBox");

function setStatus(msg) {
  statusEl.textContent = msg;
}

// --- Hide everything in the avatar page except the avatar itself ---
function hideAvatarControls() {
  try {
    const doc = iframe.contentDocument || iframe.contentWindow.document;
    if (!doc || !doc.body) return false;
    if (doc.getElementById("__isl_hide_style__")) return true; // already done
    const style = doc.createElement("style");
    style.id = "__isl_hide_style__";
    style.textContent = `
      .divCtrlPanel { display: none !important; }
      h3 { display: none !important; }
    `;
    doc.head.appendChild(style);
    return true;
  } catch (e) {
    console.error("Could not access iframe document:", e);
    return false;
  }
}

// --- Force the avatar dropdown to actually switch to marc ---
// Setting `selected` in the saved HTML only changes what the <select> SHOWS,
// not which 3D model CWASA loads. CWASA only swaps the avatar in response to
// a genuine 'change' event firing on the <select>. So we set the value via JS
// and manually dispatch that event to trigger the real switch.
function forceMarcAvatar() {
  try {
    const doc = iframe.contentDocument || iframe.contentWindow.document;
    if (!doc || !doc.body) return false;
    const select = doc.querySelector("select.menuAv.av0");
    if (!select) return false;
    if (select.value === "marc" && select.dataset.__islForced === "1") return true;
    select.value = "marc";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    select.dataset.__islForced = "1";
    return true;
  } catch (e) {
    console.error("Could not force avatar selection:", e);
    return false;
  }
}

// --- Manual speed control: click the avatar's real speed buttons and
// keep our own display in sync with its actual current value. ---
const speedDisplay = document.getElementById("speedDisplay");

function readCurrentSpeed() {
  try {
    const doc = iframe.contentDocument || iframe.contentWindow.document;
    const field = doc.querySelector("input.txtLogSpeed.av0");
    return field ? field.value : null;
  } catch (e) {
    return null;
  }
}

function updateSpeedDisplay() {
  const val = readCurrentSpeed();
  if (val !== null && speedDisplay) speedDisplay.textContent = val;
}

function clickSpeedButton(direction) {
  try {
    const doc = iframe.contentDocument || iframe.contentWindow.document;
    const selector = direction === "up" ? "input.bttnSpeedUp.av0" : "input.bttnSpeedDown.av0";
    const btn = doc.querySelector(selector);
    if (!btn) return false;
    btn.click();
    updateSpeedDisplay();
    return true;
  } catch (e) {
    console.error("Could not change avatar speed:", e);
    return false;
  }
}

document.getElementById("speedUpBtn").addEventListener("click", () => clickSpeedButton("up"));
document.getElementById("speedDownBtn").addEventListener("click", () => clickSpeedButton("down"));

// Slow it down once by default when the avatar first loads (starts at
// +0.0, one click down lands on -1.0), then keep the display accurate.
function slowDownOnce() {
  try {
    const doc = iframe.contentDocument || iframe.contentWindow.document;
    if (!doc || !doc.body) return false;
    const btn = doc.querySelector("input.bttnSpeedDown.av0");
    if (!btn) return false;
    if (btn.dataset.__islSpeedSet === "1") {
      updateSpeedDisplay();
      return true;
    }
    btn.click();
    btn.dataset.__islSpeedSet = "1";
    updateSpeedDisplay();
    return true;
  } catch (e) {
    console.error("Could not adjust avatar speed:", e);
    return false;
  }
}

// Try right away, in case the iframe already finished loading
hideAvatarControls();
forceMarcAvatar();
slowDownOnce();
// Also try when it loads (covers the case where it wasn't ready yet)
iframe.addEventListener("load", () => {
  hideAvatarControls();
  forceMarcAvatar();
  slowDownOnce();
});
// Safety net: keep retrying briefly in case of timing issues
// (avatar asset loading over the network can be slower than the panel-hide)
let hideAttempts = 0;
const hideRetryTimer = setInterval(() => {
  hideAttempts++;
  const hidden = hideAvatarControls();
  const forced = forceMarcAvatar();
  const slowed = slowDownOnce();
  if ((hidden && forced && slowed) || hideAttempts > 20) {
    clearInterval(hideRetryTimer);
    const cover = document.getElementById("avatarLoadingCover");
    if (cover) cover.style.display = "none";
  }
}, 250);

// --- Step 1: send raw text to the backend, get back glosses + ready SiGML ---
// The backend (server.js -> lib/signEngine.js) now does everything the
// architecture diagram shows: parse text -> match against the HamNoSys
// database -> extract HamNoSys tokens -> convert to SiGML. This client
// only has to hand over the text and play whatever comes back.
async function generateSign(text) {
  const res = await fetch("/api/sign", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text })
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error || "Could not generate sign.");
  }
  return data; // { glosses, sigml, unresolved }
}
// Returns true if the sign was actually triggered, false otherwise.
// IMPORTANT: the avatar page's Play control is <input type="button" ...>,
// NOT a <button> element -- querySelectorAll("button") will never find it.
// We target the real elements directly by the classes CWASA gives them
// (visible when inspecting the avatar page's HTML: class="txtaSiGMLText av0"
// and class="bttnPlaySiGMLText av0").
function playInAvatar(sigmlText) {
  const doc = iframe.contentDocument || iframe.contentWindow.document;

  const textarea = doc.querySelector("textarea.txtaSiGMLText.av0") || doc.querySelector("textarea");
  if (!textarea) {
    setStatus("Could not find the SiGML text box inside the avatar page. Inspect it and update script.js.");
    return false;
  }
  textarea.value = sigmlText;
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
  textarea.dispatchEvent(new Event("change", { bubbles: true }));

  const playButton = doc.querySelector("input.bttnPlaySiGMLText.av0");
  if (!playButton) {
    setStatus("Could not find the Play button inside the avatar page. Inspect it and update script.js.");
    return false;
  }
  if (playButton.disabled) {
    setStatus("Play button is disabled inside the avatar page -- avatar may still be loading.");
    return false;
  }
  playButton.click();
  return true;
}

// --- Wire up the Play button ---
document.getElementById("playBtn").addEventListener("click", async () => {
  const text = inputEl.value;
  if (!text.trim()) {
    setStatus("Type something first.");
    return;
  }

  textOnlyBox.textContent = text;
  glossBox.textContent = "…";

  try {
    setStatus("Looking up sign(s)...");
    const { glosses, sigml, unresolved, nearMatches } = await generateSign(text);

    if (!glosses || glosses.length === 0) {
      setStatus("No recognizable digit, letter, or word sign found in that input yet.");
      glossBox.textContent = "(none recognized)";
      return;
    }

    glossBox.textContent = glosses.join(", ");

    const played = playInAvatar(sigml);
    if (played) {
      const notes = [];
      if (nearMatches && nearMatches.length) {
        notes.push(`used closest match for: ${nearMatches.map(m => `"${m.original}"→"${m.matched}"`).join(", ")}`);
      }
      if (unresolved && unresolved.length) {
        notes.push(`no sign yet for: ${unresolved.join(", ")}`);
      }
      setStatus(
        notes.length
          ? `Playing: ${glosses.join(", ")} (${notes.join("; ")})`
          : `Playing: ${glosses.join(", ")}`
      );
    }
    // if played is false, playInAvatar() already set a specific error status --
    // leave it visible instead of overwriting it.
  } catch (err) {
    setStatus("Error: " + err.message);
  }
});

// --- Voice input using the browser's built-in Web Speech API ---
const micBtn = document.getElementById("micBtn");
const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

if (SpeechRecognition) {
  const recognizer = new SpeechRecognition();
  recognizer.lang = "en-IN";
  recognizer.interimResults = false;

  micBtn.addEventListener("click", () => {
    setStatus("Listening...");
    recognizer.start();
  });

  recognizer.addEventListener("result", (event) => {
    const transcript = event.results[0][0].transcript;
    inputEl.value = transcript;
    setStatus(`Heard: "${transcript}"`);
  });

  recognizer.addEventListener("error", (event) => {
    setStatus("Voice input error: " + event.error);
  });
} else {
  micBtn.disabled = true;
  micBtn.title = "Voice input not supported in this browser (try Chrome)";
}
