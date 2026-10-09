"""Character Voice Agent — FastAPI backend (Milestone 1).

Serves the static frontend from ``public/`` and exposes ``character.json`` so the
browser can fetch the character settings. Loads ``.env`` with python-dotenv when
present but runs fine without it. AWS keys are never read or printed here.
"""

import asyncio
import json
import uuid
from pathlib import Path
from typing import Literal

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

# Load .env if present. load_dotenv() is a no-op when the file is missing, so the
# app runs fine without it (e.g. on the server, which uses its own AWS role).
try:
    from dotenv import load_dotenv

    load_dotenv()
except Exception:
    # python-dotenv missing or unreadable .env — keep running, never crash.
    pass

BASE_DIR = Path(__file__).resolve().parent
PUBLIC_DIR = BASE_DIR / "public"
CHARACTER_FILE = BASE_DIR / "character.json"

AWS_REGION = "us-east-1"
MODEL_ID = "us.amazon.nova-lite-v1:0"
MAX_INPUT_CHARS = 500
MAX_HISTORY = 20  # keep ~last 20 messages of context

app = FastAPI()


def load_character() -> dict:
    """Read character.json fresh each time (cheap, and lets edits apply on reload)."""
    try:
        return json.loads(CHARACTER_FILE.read_text(encoding="utf-8"))
    except Exception:
        return {"name": "Character", "personality": "A friendly character."}


# --- AI agent (LangGraph + Amazon Nova Lite) --------------------------------
# Built lazily on first use so the app imports/starts WITHOUT AWS keys and
# without importing heavy deps until a chat actually happens.

_agent = None


class Reply:
    """Placeholder type hint; real Pydantic model defined in _build_agent."""


def _build_agent():
    """Create the compiled LangGraph agent. Imports live here so module import
    never needs AWS or the AI deps."""
    from langchain_aws import ChatBedrockConverse
    from langchain_core.messages import SystemMessage
    from langgraph.checkpoint.memory import InMemorySaver
    from langgraph.graph import START, MessagesState, StateGraph
    from pydantic import BaseModel, Field

    class ReplyModel(BaseModel):
        text: str = Field(description="The character's reply, 1-3 short sentences.")
        emotion: Literal["neutral", "happy", "angry", "sad", "relaxed"] = Field(
            default="neutral", description="The emotion behind the reply."
        )

    char = load_character()
    name = char.get("name", "Character")
    personality = char.get("personality", "A friendly character.")

    system_prompt = (
        f"You are {name}. {personality}\n\n"
        "Stay fully in character at all times. Reply in 1 to 3 short sentences. "
        "Do not use bullet points, numbered lists, or emojis. Be natural and "
        "conversational. Choose an emotion that fits your reply."
    )

    llm = ChatBedrockConverse(
        model=MODEL_ID,
        region_name=AWS_REGION,
        temperature=0.7,
        max_tokens=300,
    )
    structured = llm.with_structured_output(ReplyModel)

    def call_model(state: MessagesState):
        # Keep only the last MAX_HISTORY messages for context.
        history = state["messages"][-MAX_HISTORY:]
        reply: ReplyModel = structured.invoke(
            [SystemMessage(content=system_prompt), *history]
        )
        # Store the plain text back into memory; stash emotion on the object.
        from langchain_core.messages import AIMessage

        ai = AIMessage(content=reply.text)
        ai.additional_kwargs["emotion"] = reply.emotion
        return {"messages": [ai]}

    builder = StateGraph(MessagesState)
    builder.add_node("model", call_model)
    builder.add_edge(START, "model")
    return builder.compile(checkpointer=InMemorySaver())


def get_agent():
    global _agent
    if _agent is None:
        _agent = _build_agent()
    return _agent


def run_turn(thread_id: str, user_text: str) -> dict:
    """Blocking: invoke the agent for one user message. Returns {text, emotion}."""
    from langchain_core.messages import HumanMessage

    agent = get_agent()
    result = agent.invoke(
        {"messages": [HumanMessage(content=user_text)]},
        config={"configurable": {"thread_id": thread_id}},
    )
    last = result["messages"][-1]
    return {
        "text": last.content,
        "emotion": last.additional_kwargs.get("emotion", "neutral"),
    }


@app.websocket("/ws")
async def ws(websocket: WebSocket) -> None:
    """One WebSocket per page. Each gets its own conversation memory via a
    unique thread_id. JSON in/out."""
    await websocket.accept()
    thread_id = str(uuid.uuid4())
    try:
        while True:
            raw = await websocket.receive_text()
            try:
                msg = json.loads(raw)
            except Exception:
                continue
            if msg.get("type") != "user_message":
                continue
            text = (msg.get("text") or "").strip()[:MAX_INPUT_CHARS]
            if not text:
                continue
            try:
                # Run the blocking Bedrock/graph call off the event loop.
                reply = await asyncio.to_thread(run_turn, thread_id, text)
                await websocket.send_text(
                    json.dumps({"type": "reply", **reply})
                )
            except Exception as e:  # noqa: BLE001
                # Never leak internals/keys to the browser; log server-side.
                print(f"[ws] agent error: {type(e).__name__}: {e}")
                await websocket.send_text(
                    json.dumps(
                        {
                            "type": "error",
                            "message": "Hmm, I glitched for a second. Try again?",
                        }
                    )
                )
    except WebSocketDisconnect:
        pass


@app.get("/character.json")
def character() -> FileResponse:
    """Return the root character.json so the frontend can fetch its settings."""
    return FileResponse(CHARACTER_FILE, media_type="application/json")


# Mount the static frontend LAST so it doesn't shadow the /character.json route.
# html=True serves public/index.html at "/" and resolves /avatars, /animations,
# /music, /style.css, /main.js, /loadMixamoAnimation.js directly.
app.mount("/", StaticFiles(directory=PUBLIC_DIR, html=True), name="public")
