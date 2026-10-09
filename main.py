"""Character Voice Agent — FastAPI backend (Milestone 1).

Serves the static frontend from ``public/`` and exposes ``character.json`` so the
browser can fetch the character settings. Loads ``.env`` with python-dotenv when
present but runs fine without it. AWS keys are never read or printed here.
"""

import asyncio
import base64
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


# --- Voice (Amazon Polly) ---------------------------------------------------

_polly = None


def _get_polly():
    global _polly
    if _polly is None:
        import boto3

        _polly = boto3.client("polly", region_name=AWS_REGION)
    return _polly


def synthesize_speech(text: str) -> dict:
    """Blocking: call Polly twice in parallel — mp3 audio + viseme/word marks.
    Returns {audio: base64 mp3, visemes: [{time, value}, ...]}."""
    import concurrent.futures

    char = load_character()
    voice = char.get("voice", {})
    voice_id = voice.get("id", "Matthew")
    engine = voice.get("engine", "neural")
    polly = _get_polly()

    def _audio():
        resp = polly.synthesize_speech(
            Text=text, OutputFormat="mp3", VoiceId=voice_id, Engine=engine
        )
        return resp["AudioStream"].read()

    def _marks():
        resp = polly.synthesize_speech(
            Text=text,
            OutputFormat="json",
            VoiceId=voice_id,
            Engine=engine,
            SpeechMarkTypes=["viseme", "word"],
        )
        raw = resp["AudioStream"].read().decode("utf-8")
        visemes = []
        for line in raw.splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                mark = json.loads(line)
            except Exception:
                continue
            if mark.get("type") == "viseme":
                visemes.append({"time": mark["time"], "value": mark["value"]})
        return visemes

    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as ex:
        f_audio = ex.submit(_audio)
        f_marks = ex.submit(_marks)
        audio_bytes = f_audio.result()
        visemes = f_marks.result()

    return {
        "audio": base64.b64encode(audio_bytes).decode("ascii"),
        "visemes": visemes,
    }


def run_turn_with_voice(thread_id: str, user_text: str) -> dict:
    """Agent reply + Polly voice. Returns {text, emotion, audio, visemes}.
    Voice failures degrade gracefully to text-only."""
    reply = run_turn(thread_id, user_text)
    try:
        speech = synthesize_speech(reply["text"])
        reply.update(speech)
    except Exception as e:  # noqa: BLE001
        print(f"[polly] synthesis failed, text-only: {type(e).__name__}: {e}")
    return reply


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
                # Run the blocking Bedrock + Polly calls off the event loop.
                reply = await asyncio.to_thread(
                    run_turn_with_voice, thread_id, text
                )
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


@app.websocket("/transcribe")
async def transcribe_ws(websocket: WebSocket) -> None:
    """Bonus A: stream 16kHz PCM mic audio from the browser to Amazon
    Transcribe and send partial/final transcripts back as JSON.

    Protocol:
      client -> server: binary frames of 16-bit PCM @ 16kHz; a text frame
                        '{"type":"stop"}' ends the utterance.
      server -> client: {"type":"partial"|"final","text":"..."}
    """
    await websocket.accept()

    try:
        from amazon_transcribe.client import TranscribeStreamingClient
        from amazon_transcribe.handlers import TranscriptResultStreamHandler
        from amazon_transcribe.model import TranscriptEvent
    except Exception as e:  # noqa: BLE001
        print(f"[transcribe] library unavailable: {e}")
        await websocket.send_text(
            json.dumps({"type": "error", "message": "Mic not available."})
        )
        await websocket.close()
        return

    client = TranscribeStreamingClient(region=AWS_REGION)
    stream = await client.start_stream_transcription(
        language_code="en-US",
        media_sample_rate_hz=16000,
        media_encoding="pcm",
    )

    class Handler(TranscriptResultStreamHandler):
        async def handle_transcript_event(self, event: TranscriptEvent):
            for result in event.transcript.results:
                if not result.alternatives:
                    continue
                text = result.alternatives[0].transcript
                kind = "partial" if result.is_partial else "final"
                try:
                    await websocket.send_text(
                        json.dumps({"type": kind, "text": text})
                    )
                except Exception:
                    pass

    handler = Handler(stream.output_stream)

    async def pump_audio():
        try:
            while True:
                message = await websocket.receive()
                if "bytes" in message and message["bytes"] is not None:
                    await stream.input_stream.send_audio_event(
                        audio_chunk=message["bytes"]
                    )
                elif "text" in message and message["text"] is not None:
                    try:
                        ctrl = json.loads(message["text"])
                    except Exception:
                        continue
                    if ctrl.get("type") == "stop":
                        break
        except WebSocketDisconnect:
            pass
        finally:
            # Close the input so Transcribe finalizes (avoids the 15s timeout).
            await stream.input_stream.end_stream()

    try:
        await asyncio.gather(pump_audio(), handler.handle_events())
    except Exception as e:  # noqa: BLE001
        print(f"[transcribe] error: {type(e).__name__}: {e}")
    finally:
        try:
            await websocket.close()
        except Exception:
            pass


@app.get("/character.json")
def character() -> FileResponse:
    """Return the root character.json so the frontend can fetch its settings."""
    return FileResponse(CHARACTER_FILE, media_type="application/json")


# Mount the static frontend LAST so it doesn't shadow the /character.json route.
# html=True serves public/index.html at "/" and resolves /avatars, /animations,
# /music, /style.css, /main.js, /loadMixamoAnimation.js directly.
app.mount("/", StaticFiles(directory=PUBLIC_DIR, html=True), name="public")
