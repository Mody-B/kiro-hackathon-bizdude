// Chat + voice + controls. Talks to the server over WebSockets and drives the
// character via window.VRMControls (defined in main.js).

const messagesEl = document.getElementById("messages");
const formEl = document.getElementById("chat-form");
const inputEl = document.getElementById("chat-input");
const sendEl = document.getElementById("chat-send");
const bubbleEl = document.getElementById("bubble");
const danceBtn = document.getElementById("dance-btn");
const micBtn = document.getElementById("mic-btn");

let socket = null;
let waiting = false;
let pendingEl = null;

// --- helpers ---------------------------------------------------------------

function ctrl() {
  return window.VRMControls || null;
}

function wsUrl(path) {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${location.host}${path}`;
}

function addMessage(text, cls) {
  const div = document.createElement("div");
  div.className = `msg ${cls}`;
  div.textContent = text;
  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  return div;
}

function showBubble(text) {
  bubbleEl.textContent = text;
  bubbleEl.classList.remove("hidden");
}

function hideBubble() {
  bubbleEl.classList.add("hidden");
}

function setWaiting(on) {
  waiting = on;
  inputEl.disabled = on;
  sendEl.disabled = on;
  if (!on) inputEl.focus();
}

// --- chat socket -----------------------------------------------------------

function connect() {
  socket = new WebSocket(wsUrl("/ws"));

  socket.addEventListener("open", () => {
    inputEl.disabled = false;
    sendEl.disabled = false;
    inputEl.focus();
  });

  socket.addEventListener("message", (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }

    if (pendingEl) {
      pendingEl.remove();
      pendingEl = null;
    }

    if (msg.type === "reply") {
      addMessage(msg.text, "bot");
      showBubble(msg.text);
      // Drive the character: emotion + voice + lip sync + talking animation.
      ctrl()?.speak(msg.emotion, msg.audio, msg.visemes, () => hideBubble());
    } else if (msg.type === "error") {
      addMessage(msg.message || "Something went wrong. Try again?", "error");
      ctrl()?.interrupt();
    }
    setWaiting(false);
  });

  socket.addEventListener("close", () => {
    if (!waiting) {
      inputEl.disabled = true;
      sendEl.disabled = true;
    }
  });

  socket.addEventListener("error", () => {
    if (pendingEl) {
      pendingEl.remove();
      pendingEl = null;
    }
    addMessage("Connection trouble. Refresh if this persists.", "error");
    setWaiting(false);
  });
}

function sendUserMessage(text) {
  text = text.trim().slice(0, 500);
  if (!text) return;
  if (!socket || socket.readyState !== WebSocket.OPEN) return;

  // Interrupt whatever the character is doing (barge-in).
  ctrl()?.interrupt();
  hideBubble();

  addMessage(text, "user");
  pendingEl = addMessage("…", "bot pending");
  setWaiting(true);
  ctrl()?.thinking();

  socket.send(JSON.stringify({ type: "user_message", text }));
}

formEl.addEventListener("submit", (e) => {
  e.preventDefault();
  if (waiting) return;
  const text = inputEl.value;
  inputEl.value = "";
  sendUserMessage(text);
});

connect();

// --- Dance button ----------------------------------------------------------

danceBtn.addEventListener("click", () => {
  const c = ctrl();
  if (!c) return;
  c.toggleDance();
  danceBtn.classList.toggle("active", c.isDancing());
});

// --- Push-to-talk mic (Bonus A) --------------------------------------------
// Only works on localhost or https. Hide otherwise.

const micSupported =
  location.protocol === "https:" ||
  location.hostname === "localhost" ||
  location.hostname === "127.0.0.1";

if (!micSupported || !navigator.mediaDevices?.getUserMedia) {
  micBtn.classList.add("hidden");
}

let micStream = null;
let audioCtx = null;
let workletNode = null;
let micSocket = null;
let recording = false;
let finalTranscript = "";
let autoStopTimer = null;

async function startRecording() {
  if (recording) return;
  recording = true;
  finalTranscript = "";
  micBtn.classList.add("recording");

  // Interrupt the character and show thinking.
  ctrl()?.interrupt();
  hideBubble();
  ctrl()?.thinking();

  try {
    micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (e) {
    addMessage("Microphone blocked. Check the mic permission.", "error");
    stopRecordingCleanup();
    return;
  }

  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  await audioCtx.audioWorklet.addModule("/mic-worklet.js");

  micSocket = new WebSocket(wsUrl("/transcribe"));
  micSocket.binaryType = "arraybuffer";

  micSocket.addEventListener("message", (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (msg.type === "partial") {
      showBubble(msg.text + " …");
    } else if (msg.type === "final") {
      finalTranscript = msg.text;
    } else if (msg.type === "error") {
      addMessage(msg.message || "Mic error.", "error");
    }
  });

  micSocket.addEventListener("open", () => {
    const source = audioCtx.createMediaStreamSource(micStream);
    workletNode = new AudioWorkletNode(audioCtx, "pcm-16k");
    workletNode.port.onmessage = (e) => {
      // e.data is an ArrayBuffer of 16-bit PCM @ 16kHz.
      if (micSocket && micSocket.readyState === WebSocket.OPEN) {
        micSocket.send(e.data);
      }
    };
    source.connect(workletNode);
    // Do NOT connect worklet to destination (avoid echo).
  });

  // Safety: stop after 30 seconds.
  autoStopTimer = setTimeout(stopRecording, 30000);
}

function stopRecording() {
  if (!recording) return;
  recording = false;
  micBtn.classList.remove("recording");
  clearTimeout(autoStopTimer);

  // Tell the server to finalize.
  if (micSocket && micSocket.readyState === WebSocket.OPEN) {
    micSocket.send(JSON.stringify({ type: "stop" }));
  }

  // Give Transcribe a moment to send the final transcript, then send it as a
  // normal message.
  setTimeout(() => {
    const text = (finalTranscript || "").trim();
    hideBubble();
    stopRecordingCleanup();
    if (text) {
      inputEl.value = "";
      sendUserMessage(text);
    } else {
      ctrl()?.interrupt();
    }
  }, 700);
}

function stopRecordingCleanup() {
  try {
    workletNode?.disconnect();
  } catch {}
  try {
    micStream?.getTracks().forEach((t) => t.stop());
  } catch {}
  try {
    audioCtx?.close();
  } catch {}
  try {
    micSocket?.close();
  } catch {}
  workletNode = null;
  micStream = null;
  audioCtx = null;
  micSocket = null;
  recording = false;
  micBtn.classList.remove("recording");
}

// Hold-to-talk: mouse/touch on the button.
micBtn.addEventListener("mousedown", (e) => {
  e.preventDefault();
  startRecording();
});
micBtn.addEventListener("mouseup", stopRecording);
micBtn.addEventListener("mouseleave", () => {
  if (recording) stopRecording();
});
micBtn.addEventListener("touchstart", (e) => {
  e.preventDefault();
  startRecording();
});
micBtn.addEventListener("touchend", (e) => {
  e.preventDefault();
  stopRecording();
});

// Hold Space to talk, but not while typing in the input.
document.addEventListener("keydown", (e) => {
  if (e.code !== "Space") return;
  if (document.activeElement === inputEl) return;
  if (!micSupported) return;
  if (recording) return;
  e.preventDefault();
  startRecording();
});
document.addEventListener("keyup", (e) => {
  if (e.code !== "Space") return;
  if (!recording) return;
  e.preventDefault();
  stopRecording();
});
