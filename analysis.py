"""Gemini-powered analysis: prompts, response schemas, and the model call."""

import json
import os
import time

from google import genai
from google.genai import types

MODEL = os.environ.get("GEMINI_MODEL", "gemini-3.5-flash-lite")
RETRIES = 2

SYSTEM_INSTRUCTION = """You are PaperMind, an expert research analyst who helps researchers \
understand academic papers quickly and accurately.

Rules:
- Base every statement on the provided document. Never invent results, numbers, datasets, or citations.
- If something is not stated in the document, say "Not specified" rather than guessing.
- Preserve exact figures (percentages, p-values, sample sizes, metrics) where the paper reports them.
- Write in clear, precise academic English suitable for a graduate-level reader."""

_str = {"type": "STRING"}
_str_list = {"type": "ARRAY", "items": _str}


def _obj(properties, required=None):
    return {"type": "OBJECT", "properties": properties, "required": required or list(properties)}


SECTIONS = {
    "overview": {
        "prompt": """Produce an overview of this document.
- title / authors / year / venue: exactly as stated in the document ("Not specified" if absent).
- field: the research field and sub-field (e.g. "Computer Science · Natural Language Processing").
- paper_type: e.g. Empirical study, Survey / Review, Theoretical, System / Tool, Case study, Thesis.
- tldr: one sentence (max 30 words) capturing the core contribution.
- summary: 5-7 sentences covering motivation, objective, approach, key result, and conclusion.
- research_questions: the research questions or hypotheses the paper addresses (2-4).
- contributions: the main contributions claimed (3-5).
- keywords: 5-8 key terms.
- citation_apa and citation_bibtex: a citation built only from details in the document; \
use "n.d." for a missing year and omit fields you cannot find.""",
        "schema": _obj({
            "title": _str, "authors": _str_list, "year": _str, "venue": _str,
            "field": _str, "paper_type": _str, "tldr": _str, "summary": _str,
            "research_questions": _str_list, "contributions": _str_list, "keywords": _str_list,
            "citation_apa": _str, "citation_bibtex": _str,
        }),
    },
    "methodology": {
        "prompt": """Extract the methodology of this document.
- approach: the overall research design in one sentence (e.g. "Randomized controlled trial", \
"Supervised deep learning with transformer encoders").
- steps: the pipeline in order, 3-7 steps. label is 2-4 words for a flow diagram; \
description is 1-2 sentences of specifics.
- data: datasets, corpora, participants or samples used, with sizes if stated.
- tools: models, instruments, software, frameworks, or statistical techniques.
- evaluation: how results were measured (metrics, baselines, validation strategy).""",
        "schema": _obj({
            "approach": _str,
            "steps": {"type": "ARRAY", "items": _obj({"label": _str, "description": _str})},
            "data": _str_list, "tools": _str_list, "evaluation": _str,
        }),
    },
    "findings": {
        "prompt": """Extract the 4-7 most important findings and results of this document.
- finding: the result stated as a clear claim.
- evidence: the supporting numbers, comparison, or statistic from the paper \
(or "Qualitative finding" if none is reported).
- significance: one short phrase on why it matters.""",
        "schema": _obj({
            "findings": {"type": "ARRAY", "items": _obj({
                "finding": _str, "evidence": _str, "significance": _str,
            })},
        }),
    },
    "gaps": {
        "prompt": """Critically assess this document.
- limitations: weaknesses the authors acknowledge (label ones you infer with "(inferred)").
- gaps: open research gaps this work leaves unaddressed — concrete opportunities for new research.
- future_work: directions the authors propose, or natural next studies.
- threats_to_validity: issues with internal/external validity, bias, reproducibility, or generalizability.
Give 2-5 items each.""",
        "schema": _obj({
            "limitations": _str_list, "gaps": _str_list,
            "future_work": _str_list, "threats_to_validity": _str_list,
        }),
    },
    "concepts": {
        "prompt": """Build a glossary of the 6-12 key technical terms, methods, and concepts a reader \
needs to understand this document. Define each in 1-2 plain-language sentences, \
in the sense the paper uses it.""",
        "schema": _obj({
            "concepts": {"type": "ARRAY", "items": _obj({"term": _str, "definition": _str})},
        }),
    },
    "quiz": {
        "prompt": """Write 6 multiple-choice questions that test genuine understanding of this document \
(motivation, method, results, and implications — not trivia).
Each question has exactly 4 plausible options, answer_index is the 0-based index of the correct \
option, and explanation says why it is correct with reference to the paper.""",
        "schema": _obj({
            "questions": {"type": "ARRAY", "items": _obj({
                "question": _str, "options": _str_list,
                "answer_index": {"type": "INTEGER"}, "explanation": _str,
            })},
        }),
    },
}

ASK_SCHEMA = _obj({
    "answer": _str,
    "quotes": {"type": "ARRAY", "items": _str},
    "answerable": {"type": "BOOLEAN"},
})

ASK_PROMPT = """Answer the researcher's question using only the document.
- answer: a direct, well-structured answer (use short paragraphs; plain text, no markdown headings).
- quotes: 1-3 short verbatim excerpts from the document that support the answer (empty if none).
- answerable: false if the document does not contain the information; then say so in answer \
and briefly note what the paper does cover that is related."""


class AnalysisError(Exception):
    pass


_client = None


def _get_client():
    global _client
    if _client is None:
        key = os.environ.get("GEMINI_API_KEY")
        if not key:
            raise AnalysisError("GEMINI_API_KEY is not set. Add it to your .env file and restart the server.")
        _client = genai.Client(api_key=key)
    return _client


def _friendly_error(e):
    message = str(e)
    if "API_KEY_INVALID" in message or "API key not valid" in message:
        return "Your Gemini API key was rejected. Check GEMINI_API_KEY in .env, then restart the server."
    if "RESOURCE_EXHAUSTED" in message or "429" in message:
        return "Gemini rate limit or quota reached. Wait a minute and try again."
    if "NOT_FOUND" in message and "models/" in message:
        return f"The model '{MODEL}' is not available for your API key. Set GEMINI_MODEL in .env to a supported model."
    if "UNAVAILABLE" in message or "503" in message:
        return "Gemini is temporarily overloaded. Please try again in a moment."
    return f"The AI service returned an error: {message[:300]}"


def _generate(document, instruction, schema):
    # Document goes first so repeated requests on the same paper share a cacheable prefix.
    contents = [f"<document>\n{document}\n</document>", instruction]
    config = types.GenerateContentConfig(
        system_instruction=SYSTEM_INSTRUCTION,
        response_mime_type="application/json",
        response_schema=schema,
        temperature=0.2,
    )
    for attempt in range(RETRIES + 1):
        try:
            response = _get_client().models.generate_content(model=MODEL, contents=contents, config=config)
            break
        except AnalysisError:
            raise
        except Exception as e:
            # Overload and rate-limit errors are usually brief, so retry those with backoff.
            if attempt < RETRIES and any(code in str(e) for code in ("503", "UNAVAILABLE", "429", "RESOURCE_EXHAUSTED")):
                time.sleep(2 * 2 ** attempt)
                continue
            raise AnalysisError(_friendly_error(e))
    try:
        return json.loads(response.text)
    except (TypeError, json.JSONDecodeError):
        raise AnalysisError("The AI returned an unreadable response. Please try again.")


def analyze(document, section):
    spec = SECTIONS[section]
    return _generate(document, spec["prompt"], spec["schema"])


def ask(document, question, history=()):
    convo = "\n".join(f"Q: {h['question']}\nA: {h['answer']}" for h in history[-4:])
    instruction = ASK_PROMPT
    if convo:
        instruction += f"\n\nEarlier in this conversation:\n{convo}"
    instruction += f"\n\nQuestion: {question}"
    return _generate(document, instruction, ASK_SCHEMA)
