// Chat (Milestone 2): text box + WebSocket to the server's LangGraph/Nova Lite
// agent. One socket per page; the server keeps conversation memory per socket.

const messagesEl = document.getElementById("messages");
const formEl = document.getElementById("chat-form");
const inputEl = document.getElementById("chat-input");
const sendEl = document.getElementById("chat-send");

let socket = null;
let waiting = false;
let pendingEl = null;

function wsUrl() {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${location.host}/ws`;
}

function addMessage(text, cls) {
  const div = document.createElement("div");
  div.className = `msg ${cls}`;
  div.textContent = text;
  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  return div;
}

function setWaiting(on) {
  waiting = on;
  inputEl.disabled = on;
  sendEl.disabled = on;
  if (!on) inputEl.focus();
}

function connect() {
  socket = new WebSocket(wsUrl());

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
      // emotion is carried for Milestone 4; stored, not shown yet.
      window.__lastEmotion = msg.emotion || "neutral";
    } else if (msg.type === "error") {
      addMessage(msg.message || "Something went wrong. Try again?", "error");
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

formEl.addEventListener("submit", (e) => {
  e.preventDefault();
  if (waiting) return;
  if (!socket || socket.readyState !== WebSocket.OPEN) return;

  const text = inputEl.value.trim().slice(0, 500);
  if (!text) return;

  addMessage(text, "user");
  inputEl.value = "";
  pendingEl = addMessage("…", "bot pending");
  setWaiting(true);

  socket.send(JSON.stringify({ type: "user_message", text }));
});

connect();
