"""Character Voice Agent — FastAPI backend (Milestone 1).

Serves the static frontend from ``public/`` and exposes ``character.json`` so the
browser can fetch the character settings. Loads ``.env`` with python-dotenv when
present but runs fine without it. AWS keys are never read or printed here.
"""

from pathlib import Path

from fastapi import FastAPI
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

app = FastAPI()


@app.get("/character.json")
def character() -> FileResponse:
    """Return the root character.json so the frontend can fetch its settings."""
    return FileResponse(CHARACTER_FILE, media_type="application/json")


# Mount the static frontend LAST so it doesn't shadow the /character.json route.
# html=True serves public/index.html at "/" and resolves /avatars, /animations,
# /music, /style.css, /main.js, /loadMixamoAnimation.js directly.
app.mount("/", StaticFiles(directory=PUBLIC_DIR, html=True), name="public")
