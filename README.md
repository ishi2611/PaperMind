# PaperMind

**An AI research assistant that turns any academic paper into a structured, citable breakdown.**

**Live demo: [papermind-l7sg.onrender.com](https://papermind-l7sg.onrender.com)** (free hosting, so the first load may take up to a minute while the server wakes up)

Upload a PDF, DOCX, or TXT paper and PaperMind (powered by Google Gemini) produces:

| Section | What you get |
| --- | --- |
| **Overview** | TL;DR, summary, field, paper type, research questions, contributions, keywords, and a ready-to-use **APA / BibTeX citation** |
| **Methodology** | The research pipeline as a flow diagram, a step-by-step breakdown, datasets/participants, methods & tools, and evaluation strategy |
| **Key findings** | Each result paired with its supporting evidence (figures, statistics) and why it matters |
| **Gaps & limitations** | Limitations, threats to validity, open research gaps, and future work — a starting point for your own study |
| **Key concepts** | A searchable glossary of the technical terms you need |
| **Quiz** | Scored multiple-choice questions with explanations to check your understanding |
| **Ask the paper** | Chat with the document; every answer is grounded in the text and backed by verbatim quotes |

Results can be exported as a **Markdown report** or printed / saved as a **PDF**.

## Quick start

Requires Python 3.10+.

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt

cp .env.example .env        # then paste your Gemini API key into .env
python app.py
```

Open <http://localhost:5001>. Get a free Gemini API key at <https://aistudio.google.com/apikey>.

## Configuration

Set these in `.env`:

| Variable | Default | Description |
| --- | --- | --- |
| `GEMINI_API_KEY` | — | **Required.** Your Google Gemini API key |
| `GEMINI_MODEL` | `gemini-3.5-flash-lite` | Use `gemini-3.5-flash` for higher-quality analysis |
| `MAX_WORDS` | `60000` | Longer documents are truncated to this many words (the UI tells you when this happens) |
| `RATE_LIMIT_PER_HOUR` | `40` | AI requests allowed per visitor per hour, to protect your API quota on a public deployment (`0` = unlimited) |
| `PORT` | `5001` | Server port |
| `FLASK_DEBUG` | `1` | Set to `0` in production |

## Deploy to Render (free)

The repo includes a `render.yaml` blueprint.

1. Push the repo to GitHub.
2. On [Render](https://render.com), choose **New → Blueprint** and select the repo.
3. When prompted, paste your `GEMINI_API_KEY`, then click **Apply**.

The app is served by gunicorn with a single worker, because uploaded papers are held in process memory. Free instances sleep after about 15 minutes of inactivity, so the first visit after that takes 30–60 seconds to wake up.

## How it works

```
upload ──► extraction.py ──► in-memory document store ──► analysis.py ──► Gemini (structured JSON)
          (PyMuPDF / python-docx)   (keyed by doc_id,          (prompts + response schemas)
                                     results cached)
```

- **Structured output:** every section is requested with a JSON response schema, so results are parsed reliably instead of scraped from free text.
- **Grounded analysis:** the system prompt tells the model to rely only on the document and to answer "Not specified" rather than guess.
- **Upload once, analyze many times:** the text is kept on the server under a `doc_id` and each section's result is cached, so switching tabs or exporting never triggers a new API call. Use **Regenerate** on a section to get a fresh result.
- **Privacy:** files are processed in memory and never written to disk. The document store holds the 50 most recent papers and clears when the server restarts.

## API

| Endpoint | Body | Returns |
| --- | --- | --- |
| `POST /api/upload` | multipart `file` | `{doc_id, info}`, where `info` holds title, authors, pages, words, and reading time |
| `POST /api/analyze` | `{doc_id, section, refresh?}` | `{section, data}`; `section` is one of `overview`, `methodology`, `findings`, `gaps`, `concepts`, `quiz` |
| `POST /api/ask` | `{doc_id, question, history?}` | `{answer, quotes, answerable}` |
| `GET /api/health` | — | server status and whether an API key is configured |

## Project structure

```
app.py            Flask routes and in-memory document store
analysis.py       Prompts, JSON response schemas, and the Gemini client
extraction.py     PDF / DOCX / TXT text and metadata extraction
templates/        Page markup
static/css/       Styles (light & dark themes, responsive, print)
static/js/        Frontend logic
```

## Limitations

- Scanned PDFs without a text layer need to be OCR'd first.
- Figures and tables inside images aren't read. Only the text layer is analyzed.
- AI output can contain mistakes. Verify important claims against the original paper.
