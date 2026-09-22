import os
import threading
import time
import uuid
from collections import OrderedDict, defaultdict, deque

from dotenv import load_dotenv

load_dotenv()

from flask import Flask, jsonify, render_template, request  # noqa: E402
from werkzeug.middleware.proxy_fix import ProxyFix  # noqa: E402

import analysis  # noqa: E402
from extraction import SUPPORTED_EXTENSIONS, ExtractionError, extract  # noqa: E402

MIN_WORDS = 200
MAX_WORDS = int(os.environ.get("MAX_WORDS", 60000))
MAX_DOCUMENTS = 50
MAX_UPLOAD_MB = 25
# AI requests allowed per visitor per hour; protects the API quota on a public deployment (0 = unlimited).
RATE_LIMIT_PER_HOUR = int(os.environ.get("RATE_LIMIT_PER_HOUR", 40))

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = MAX_UPLOAD_MB * 1024 * 1024
# Behind a hosting proxy (e.g. Render), trust its X-Forwarded-For so each visitor gets their own rate limit.
app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1)


class DocumentStore:
    """In-memory store of uploaded documents and their cached analyses (oldest evicted first)."""

    def __init__(self, capacity):
        self.capacity = capacity
        self._docs = OrderedDict()
        self._lock = threading.Lock()

    def add(self, doc):
        doc_id = uuid.uuid4().hex
        with self._lock:
            self._docs[doc_id] = doc
            while len(self._docs) > self.capacity:
                self._docs.popitem(last=False)
        return doc_id

    def get(self, doc_id):
        with self._lock:
            doc = self._docs.get(doc_id)
            if doc is not None:
                self._docs.move_to_end(doc_id)
            return doc


store = DocumentStore(MAX_DOCUMENTS)


class RateLimiter:
    """Sliding one-hour window of AI requests per client IP."""

    def __init__(self, limit, window=3600):
        self.limit = limit
        self.window = window
        self._hits = defaultdict(deque)
        self._lock = threading.Lock()

    def allow(self, key):
        if self.limit <= 0:
            return True
        now = time.monotonic()
        with self._lock:
            hits = self._hits[key]
            while hits and now - hits[0] > self.window:
                hits.popleft()
            if len(hits) >= self.limit:
                return False
            hits.append(now)
            return True


limiter = RateLimiter(RATE_LIMIT_PER_HOUR)
RATE_LIMITED = "You've reached the hourly analysis limit for this demo. Please try again later."


def error(message, status=400):
    return jsonify({"error": message}), status


def get_document(doc_id):
    return store.get(doc_id) if doc_id else None


EXPIRED = "This document is no longer in memory (the server may have restarted). Please upload it again."


@app.errorhandler(413)
def too_large(_):
    return error(f"File is too large. The maximum size is {MAX_UPLOAD_MB} MB.", 413)


@app.route("/")
def index():
    return render_template(
        "index.html",
        accept=",".join(SUPPORTED_EXTENSIONS),
        max_upload_mb=MAX_UPLOAD_MB,
    )


@app.route("/api/health")
def health():
    key = os.environ.get("GEMINI_API_KEY", "")
    configured = bool(key) and key != "your-api-key-here"
    return jsonify({"ok": True, "model": analysis.MODEL, "api_key_configured": configured})


@app.route("/api/upload", methods=["POST"])
def upload():
    file = request.files.get("file")
    if not file or not file.filename:
        return error("No file uploaded.")
    if not file.filename.lower().endswith(SUPPORTED_EXTENSIONS):
        return error("Unsupported file type. Please upload a PDF, DOCX, or TXT file.")

    try:
        text, info = extract(file.filename, file.read())
    except ExtractionError as e:
        return error(str(e))

    if info["words"] < MIN_WORDS:
        return error(
            f"Only {info['words']} words could be extracted (minimum {MIN_WORDS}). "
            "If this is a scanned PDF, run it through OCR first so the text is selectable."
        )

    words = text.split()
    truncated = len(words) > MAX_WORDS
    if truncated:
        text = " ".join(words[:MAX_WORDS])

    info.update(filename=file.filename, truncated=truncated, analyzed_words=min(len(words), MAX_WORDS))
    doc_id = store.add({"text": text, "info": info, "results": {}})
    return jsonify({"doc_id": doc_id, "info": info})


@app.route("/api/analyze", methods=["POST"])
def analyze():
    data = request.get_json(silent=True) or {}
    section = data.get("section")
    doc = get_document(data.get("doc_id"))

    if doc is None:
        return error(EXPIRED, 404)
    if section not in analysis.SECTIONS:
        return error("Unknown analysis section.")

    if data.get("refresh") or section not in doc["results"]:
        if not limiter.allow(request.remote_addr):
            return error(RATE_LIMITED, 429)
        try:
            doc["results"][section] = analysis.analyze(doc["text"], section)
        except analysis.AnalysisError as e:
            return error(str(e), 502)

    return jsonify({"section": section, "data": doc["results"][section]})


@app.route("/api/ask", methods=["POST"])
def ask():
    data = request.get_json(silent=True) or {}
    question = (data.get("question") or "").strip()
    doc = get_document(data.get("doc_id"))

    if doc is None:
        return error(EXPIRED, 404)
    if not question:
        return error("Please enter a question.")
    if len(question) > 1000:
        return error("Question is too long (1000 characters max).")

    if not limiter.allow(request.remote_addr):
        return error(RATE_LIMITED, 429)

    history = [h for h in data.get("history", []) if isinstance(h, dict) and "question" in h and "answer" in h]
    try:
        return jsonify(analysis.ask(doc["text"], question, history))
    except analysis.AnalysisError as e:
        return error(str(e), 502)


if __name__ == "__main__":
    app.run(debug=os.environ.get("FLASK_DEBUG", "1") == "1", port=int(os.environ.get("PORT", 5001)))
