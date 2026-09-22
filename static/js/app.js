(() => {
    'use strict';

    const SECTIONS = ['overview', 'methodology', 'findings', 'gaps', 'concepts', 'quiz'];
    const LABELS = {
        overview: 'Overview', methodology: 'Methodology', findings: 'Key findings',
        gaps: 'Gaps & limitations', concepts: 'Key concepts', quiz: 'Quiz',
    };
    const NOT_SPECIFIED = /^not specified\.?$/i;

    const state = {
        docId: null,
        info: null,
        active: 'overview',
        results: {},
        pending: {},
        errors: {},
        quizAnswers: {},
        chat: [],
        chatBusy: false,
    };

    // ---------- DOM helpers ----------
    const $ = (sel, root = document) => root.querySelector(sel);
    const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

    function el(tag, props, ...children) {
        const node = document.createElement(tag);
        for (const [key, value] of Object.entries(props || {})) {
            if (value == null || value === false) continue;
            if (key === 'class') node.className = value;
            else if (key === 'text') node.textContent = value;
            else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
            else node.setAttribute(key, value === true ? '' : value);
        }
        for (const child of children.flat()) {
            if (child == null || child === false) continue;
            node.append(child instanceof Node ? child : document.createTextNode(String(child)));
        }
        return node;
    }

    function icon(name) {
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
        use.setAttribute('href', `#i-${name}`);
        svg.append(use);
        return svg;
    }

    const has = (v) => typeof v === 'string' ? v.trim() && !NOT_SPECIFIED.test(v.trim()) : Array.isArray(v) && v.length > 0;
    const clean = (arr) => (arr || []).filter(has);

    // ---------- Feedback ----------
    let toastTimer;
    function toast(message) {
        const t = $('#toast');
        t.textContent = message;
        t.classList.add('show');
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => t.classList.remove('show'), 2200);
    }

    function banner(message) {
        $('#bannerText').textContent = message || '';
        $('#banner').hidden = !message;
    }

    async function copy(text, label = 'Copied to clipboard') {
        try {
            await navigator.clipboard.writeText(text);
            toast(label);
        } catch {
            toast('Copy failed — your browser blocked clipboard access');
        }
    }

    // ---------- API ----------
    class ExpiredError extends Error {}

    async function api(path, body) {
        const opts = body instanceof FormData
            ? { method: 'POST', body }
            : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
        let res, data;
        try {
            res = await fetch(path, opts);
            data = await res.json();
        } catch {
            throw new Error('Could not reach the server. Check that PaperMind is running and try again.');
        }
        if (res.status === 404 && path !== '/api/upload') throw new ExpiredError(data.error);
        if (!res.ok || data.error) throw new Error(data.error || `Request failed (${res.status})`);
        return data;
    }

    function handleExpired(err) {
        if (!(err instanceof ExpiredError)) return false;
        resetToLanding();
        banner(err.message);
        return true;
    }

    // ---------- Upload ----------
    const dropzone = $('#dropzone');
    const fileInput = $('#fileInput');

    ['dragenter', 'dragover'].forEach((evt) => dropzone.addEventListener(evt, (e) => {
        e.preventDefault();
        dropzone.classList.add('dragover');
    }));
    ['dragleave', 'drop'].forEach((evt) => dropzone.addEventListener(evt, (e) => {
        e.preventDefault();
        dropzone.classList.remove('dragover');
    }));
    dropzone.addEventListener('drop', (e) => {
        const file = e.dataTransfer.files[0];
        if (file) upload(file);
    });
    dropzone.addEventListener('click', (e) => {
        if (dropzone.classList.contains('busy')) e.preventDefault();
    });
    fileInput.addEventListener('change', () => {
        if (fileInput.files[0]) upload(fileInput.files[0]);
    });

    async function upload(file) {
        if (!/\.(pdf|docx|txt|md)$/i.test(file.name)) {
            banner('Unsupported file type. Please upload a PDF, DOCX, or TXT file.');
            return;
        }
        banner('');
        dropzone.classList.add('busy');
        $('#uploadStatus').textContent = 'Reading document…';
        $('#uploadFile').textContent = file.name;

        const form = new FormData();
        form.append('file', file);
        try {
            const data = await api('/api/upload', form);
            openWorkspace(data.doc_id, data.info);
        } catch (err) {
            banner(err.message);
        } finally {
            dropzone.classList.remove('busy');
            fileInput.value = '';
        }
    }

    // ---------- Workspace ----------
    function looksLikeTitle(t) {
        return t && t.length > 8 && !/\.(docx?|pdf|tex)$|^microsoft word|^untitled/i.test(t);
    }

    function openWorkspace(docId, info) {
        Object.assign(state, {
            docId, info, results: {}, pending: {}, errors: {}, quizAnswers: {}, chat: [], chatBusy: false,
        });

        const fallbackTitle = info.filename.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ');
        $('#paperFile').textContent = info.filename;
        $('#paperTitle').textContent = looksLikeTitle(info.title) ? info.title : fallbackTitle;
        $('#paperAuthors').textContent = info.authors || '';
        $('#statPages').textContent = info.pages.toLocaleString();
        $('#statWords').textContent = info.words >= 10000 ? `${Math.round(info.words / 1000)}k` : info.words.toLocaleString();
        $('#statRead').textContent = `${info.reading_minutes} min`;
        const note = $('#paperNote');
        note.hidden = !info.truncated;
        note.textContent = info.truncated
            ? `Long document: analysis uses the first ${info.analyzed_words.toLocaleString()} words.`
            : '';

        SECTIONS.forEach((s) => {
            panelBody(s).replaceChildren();
            $(`[data-panel="${s}"] .panel-tools`).replaceChildren();
            $(`[data-panel="${s}"]`).classList.remove('has-data');
            setStatus(s, '');
        });
        resetChat();

        $('#landing').hidden = true;
        $('#workspace').hidden = false;
        window.scrollTo(0, 0);
        select('overview');
    }

    function resetToLanding() {
        state.docId = null;
        $('#workspace').hidden = true;
        $('#landing').hidden = false;
        window.scrollTo(0, 0);
    }

    const panelBody = (s) => $(`[data-panel="${s}"] .panel-body`);

    function setStatus(section, status) {
        const dot = $(`.nav-item[data-section="${section}"] .status`);
        if (dot) dot.className = `status ${status}`;
    }

    function select(section, fromUser = false) {
        state.active = section;
        $$('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.section === section));
        $$('.panel').forEach((p) => p.classList.toggle('active', p.dataset.panel === section));
        if (SECTIONS.includes(section) && !state.results[section] && !state.pending[section]) {
            load(section);
        }
        if (section === 'ask') $('#chatQuestion').focus();
        if (fromUser && window.innerWidth <= 900) $('#content').scrollIntoView({ behavior: 'smooth', block: 'start' });
    }

    async function load(section, refresh = false) {
        const docId = state.docId;
        state.pending[section] = true;
        delete state.errors[section];
        setStatus(section, 'loading');
        renderLoading(section);

        try {
            const res = await api('/api/analyze', { doc_id: docId, section, refresh });
            if (docId !== state.docId) return;
            state.results[section] = res.data;
            if (section === 'quiz') state.quizAnswers = {};
            setStatus(section, 'done');
            render(section);
        } catch (err) {
            if (docId !== state.docId || handleExpired(err)) return;
            state.errors[section] = err.message;
            setStatus(section, 'error');
            renderError(section, err.message);
        } finally {
            if (docId === state.docId) delete state.pending[section];
        }
    }

    async function analyzeAll() {
        const todo = SECTIONS.filter((s) => !state.results[s] && !state.pending[s]);
        if (!todo.length) {
            toast('Everything is already analyzed');
            return;
        }
        toast(`Analyzing ${todo.length} section${todo.length > 1 ? 's' : ''}…`);
        // A small concurrency limit keeps us inside typical free-tier rate limits.
        const queue = [...todo];
        const worker = async () => { while (queue.length) await load(queue.shift()); };
        await Promise.all([worker(), worker(), worker()]);
        if (state.docId && SECTIONS.every((s) => state.results[s])) toast('Analysis complete');
    }

    // ---------- Section states ----------
    function renderLoading(section) {
        const lines = (widths) => el('div', { class: 'card' }, widths.map((w) => el('div', { class: `sk ${w}` })));
        panelBody(section).replaceChildren(el('div', { class: 'skeleton' },
            el('div', { class: 'loading-note' }, el('span', { class: 'spinner' }), `Reading the paper and extracting ${LABELS[section].toLowerCase()}…`),
            lines(['h-lg w-60', 'w-90', 'w-80']),
            lines(['w-40', 'w-90', 'w-80', 'w-60']),
            lines(['w-40', 'w-80']),
        ));
    }

    function renderError(section, message) {
        panelBody(section).replaceChildren(el('div', { class: 'state error' },
            icon('alert'),
            el('h3', { text: 'Analysis failed' }),
            el('p', { text: message }),
            el('button', { class: 'btn primary', type: 'button', onclick: () => load(section, true) }, icon('refresh'), 'Try again'),
        ));
    }

    function render(section) {
        const data = state.results[section];
        panelBody(section).replaceChildren(RENDERERS[section](data));
        $(`[data-panel="${section}"]`).classList.add('has-data');
        $(`[data-panel="${section}"] .panel-tools`).replaceChildren(
            el('button', { class: 'icon-btn', type: 'button', title: 'Copy as Markdown', 'aria-label': 'Copy as Markdown', onclick: () => copy(TO_MARKDOWN[section](data)) }, icon('copy')),
            el('button', { class: 'icon-btn', type: 'button', title: 'Regenerate', 'aria-label': 'Regenerate', onclick: () => load(section, true) }, icon('refresh')),
        );
        if (section === 'overview') applyOverviewMeta(data);
    }

    function applyOverviewMeta(d) {
        if (has(d.title)) $('#paperTitle').textContent = d.title;
        const authors = clean(d.authors);
        if (authors.length) $('#paperAuthors').textContent = formatAuthors(authors);
    }

    function formatAuthors(authors) {
        return authors.length > 4 ? `${authors.slice(0, 3).join(', ')} et al.` : authors.join(', ');
    }

    // ---------- Renderers ----------
    const card = (label, ...children) => el('div', { class: 'card' }, label && el('div', { class: 'card-label', text: label }), ...children);
    const list = (items, numbered) => el(numbered ? 'ol' : 'ul', { class: `list${numbered ? ' numbered' : ''}` }, clean(items).map((t) => el('li', { text: t })));
    const chips = (items, cls = 'chip') => el('div', { class: 'chips' }, clean(items).map((t) => el('span', { class: cls, text: t })));
    const paragraphs = (text) => el('div', { class: 'prose' }, text.split(/\n{2,}/).map((p) => el('p', { text: p.trim() })));

    const RENDERERS = {
        overview(d) {
            const meta = [
                ['Field', d.field], ['Paper type', d.paper_type], ['Year', d.year], ['Venue', d.venue],
            ].filter(([, v]) => has(v));

            let citeMode = 'apa';
            const citeBox = el('div', { class: 'cite-box apa', text: d.citation_apa });
            const tabs = el('div', { class: 'cite-tabs' });
            const setCite = (mode) => {
                citeMode = mode;
                citeBox.textContent = mode === 'apa' ? d.citation_apa : d.citation_bibtex;
                citeBox.className = `cite-box ${mode}`;
                $$('button', tabs).forEach((b) => b.classList.toggle('active', b.dataset.mode === mode));
            };
            tabs.append(
                el('button', { type: 'button', 'data-mode': 'apa', class: 'active', onclick: () => setCite('apa') }, 'APA'),
                el('button', { type: 'button', 'data-mode': 'bibtex', onclick: () => setCite('bibtex') }, 'BibTeX'),
                el('button', { type: 'button', title: 'Copy citation', onclick: () => copy(citeMode === 'apa' ? d.citation_apa : d.citation_bibtex, 'Citation copied') }, 'Copy'),
            );

            return el('div', {},
                has(d.tldr) && el('div', { class: 'card tldr' }, el('div', { class: 'card-label', text: 'TL;DR' }), el('p', { text: d.tldr })),
                card('Summary', paragraphs(d.summary || '')),
                meta.length && card('Details', el('dl', { class: 'meta-grid' }, meta.map(([k, v]) => el('div', {}, el('dt', { text: k }), el('dd', { text: v }))))),
                el('div', { class: 'grid-2' },
                    has(d.research_questions) && card('Research questions', list(d.research_questions, true)),
                    has(d.contributions) && card('Contributions', list(d.contributions)),
                ),
                has(d.keywords) && card('Keywords', chips(d.keywords, 'chip accent')),
                (has(d.citation_apa) || has(d.citation_bibtex)) && el('div', { class: 'card' },
                    el('div', { class: 'card-label' }, 'Cite this paper', tabs),
                    citeBox,
                ),
            );
        },

        methodology(d) {
            const steps = (d.steps || []).filter((s) => has(s.label));
            const flow = el('div', { class: 'flow', role: 'list', 'aria-label': 'Methodology pipeline' });
            steps.forEach((s, i) => {
                if (i) {
                    const arrow = icon('send');
                    arrow.setAttribute('class', 'flow-arrow');
                    flow.append(arrow);
                }
                flow.append(el('div', { class: 'flow-node', role: 'listitem' }, el('span', { text: i + 1 }), s.label));
            });

            return el('div', {},
                has(d.approach) && el('div', { class: 'card approach' }, icon('method'), el('p', { text: d.approach })),
                steps.length && card('Research pipeline', flow),
                steps.length && card('Step by step', el('ol', { class: 'timeline' }, steps.map((s, i) =>
                    el('li', {}, el('span', { class: 'num', text: i + 1 }), el('h4', { text: s.label }), el('p', { text: s.description }))))),
                el('div', { class: 'grid-2' },
                    has(clean(d.data)) && card('Data & participants', list(d.data)),
                    has(clean(d.tools)) && card('Methods & tools', chips(d.tools)),
                ),
                has(d.evaluation) && card('Evaluation', el('p', { class: 'prose', text: d.evaluation })),
            );
        },

        findings(d) {
            return el('div', { class: 'findings' }, (d.findings || []).map((f, i) =>
                el('div', { class: 'card finding' },
                    el('span', { class: 'num', text: i + 1 }),
                    el('h4', { text: f.finding }),
                    has(f.evidence) && el('div', { class: 'evidence' }, el('b', { text: 'Evidence' }), el('span', { text: f.evidence })),
                    has(f.significance) && el('p', { class: 'significance', text: `Why it matters: ${f.significance}` }),
                )));
        },

        gaps(d) {
            const group = (label, items, color) => has(clean(items)) && el('div', { class: 'card gap-card' },
                el('div', { class: 'card-label' }, el('span', { class: 'dot', style: `background:${color}` }), label),
                list(items));
            return el('div', {},
                el('div', { class: 'grid-2' },
                    group('Limitations', d.limitations, 'var(--warn)'),
                    group('Threats to validity', d.threats_to_validity, 'var(--danger)'),
                ),
                el('div', { class: 'grid-2' },
                    group('Open research gaps', d.gaps, 'var(--accent)'),
                    group('Future work', d.future_work, 'var(--success)'),
                ),
            );
        },

        concepts(d) {
            const terms = (d.concepts || []).filter((c) => has(c.term));
            const grid = el('div', { class: 'glossary' }, terms.map((c) =>
                el('div', { class: 'term', 'data-search': `${c.term} ${c.definition}`.toLowerCase() },
                    el('h4', { text: c.term }), el('p', { text: c.definition }))));
            const search = el('input', {
                class: 'search', type: 'search', placeholder: `Filter ${terms.length} terms…`, 'aria-label': 'Filter terms',
                oninput: (e) => {
                    const q = e.target.value.trim().toLowerCase();
                    $$('.term', grid).forEach((t) => { t.hidden = q && !t.dataset.search.includes(q); });
                },
            });
            return el('div', {}, terms.length > 6 && search, grid);
        },

        quiz(d) {
            const questions = (d.questions || []).filter((q) => q.options && q.options.length >= 2);
            const scoreText = el('strong');
            const bar = el('div');
            const retake = el('button', { class: 'btn small', type: 'button', onclick: () => { state.quizAnswers = {}; render('quiz'); } }, icon('refresh'), 'Retake');

            const updateScore = () => {
                const answered = Object.keys(state.quizAnswers).length;
                const correct = Object.entries(state.quizAnswers).filter(([i, a]) => questions[i].answer_index === a).length;
                scoreText.textContent = answered === questions.length
                    ? `Score: ${correct} / ${questions.length}${correct === questions.length ? ' — perfect!' : ''}`
                    : `${answered} of ${questions.length} answered · ${correct} correct`;
                bar.style.width = `${(answered / questions.length) * 100}%`;
                retake.hidden = answered === 0;
            };

            const items = questions.map((q, qi) => {
                const wrap = el('div', { class: 'card question' });
                const buttons = q.options.map((opt, oi) => el('button', {
                    class: 'option', type: 'button', 'data-correct': oi === q.answer_index,
                    onclick: () => answer(qi, oi),
                }, el('span', { class: 'letter', text: 'ABCDEF'[oi] }), el('span', { text: opt })));

                const answer = (qIdx, choice) => {
                    state.quizAnswers[qIdx] = choice;
                    wrap.classList.add('answered');
                    buttons.forEach((b, i) => {
                        b.disabled = true;
                        if (i === q.answer_index) b.classList.add('correct');
                        else if (i === choice) b.classList.add('wrong');
                    });
                    updateScore();
                };

                wrap.append(
                    el('h4', {}, el('span', { text: `Q${qi + 1}` }), q.question),
                    el('div', { class: 'options' }, buttons),
                    has(q.explanation) && el('div', { class: 'explanation', text: q.explanation }),
                );
                if (qi in state.quizAnswers) answer(qi, state.quizAnswers[qi]);
                return wrap;
            });

            updateScore();
            return el('div', {},
                el('div', { class: 'quiz-score' }, scoreText, el('div', { class: 'progress' }, bar), retake),
                items);
        },
    };

    // ---------- Markdown ----------
    const mdList = (items, numbered) => clean(items).map((t, i) => `${numbered ? `${i + 1}.` : '-'} ${t}`).join('\n');

    const TO_MARKDOWN = {
        overview: (d) => [
            has(d.tldr) && `**TL;DR:** ${d.tldr}`,
            `### Summary\n\n${d.summary}`,
            [['Field', d.field], ['Type', d.paper_type], ['Year', d.year], ['Venue', d.venue]]
                .filter(([, v]) => has(v)).map(([k, v]) => `- **${k}:** ${v}`).join('\n'),
            has(d.research_questions) && `### Research questions\n\n${mdList(d.research_questions, true)}`,
            has(d.contributions) && `### Contributions\n\n${mdList(d.contributions)}`,
            has(d.keywords) && `**Keywords:** ${clean(d.keywords).join(', ')}`,
            has(d.citation_apa) && `### Citation\n\n${d.citation_apa}`,
            has(d.citation_bibtex) && `\`\`\`bibtex\n${d.citation_bibtex}\n\`\`\``,
        ].filter(Boolean).join('\n\n'),

        methodology: (d) => [
            has(d.approach) && `**Approach:** ${d.approach}`,
            has(d.steps) && `**Pipeline:** ${d.steps.map((s) => s.label).join(' → ')}`,
            has(d.steps) && `### Steps\n\n${d.steps.map((s, i) => `${i + 1}. **${s.label}** — ${s.description}`).join('\n')}`,
            has(clean(d.data)) && `### Data\n\n${mdList(d.data)}`,
            has(clean(d.tools)) && `### Methods & tools\n\n${mdList(d.tools)}`,
            has(d.evaluation) && `### Evaluation\n\n${d.evaluation}`,
        ].filter(Boolean).join('\n\n'),

        findings: (d) => (d.findings || []).map((f, i) => [
            `${i + 1}. **${f.finding}**`,
            has(f.evidence) && `   - Evidence: ${f.evidence}`,
            has(f.significance) && `   - Why it matters: ${f.significance}`,
        ].filter(Boolean).join('\n')).join('\n'),

        gaps: (d) => [
            ['Limitations', d.limitations], ['Threats to validity', d.threats_to_validity],
            ['Open research gaps', d.gaps], ['Future work', d.future_work],
        ].filter(([, v]) => has(clean(v))).map(([k, v]) => `### ${k}\n\n${mdList(v)}`).join('\n\n'),

        concepts: (d) => (d.concepts || []).map((c) => `- **${c.term}:** ${c.definition}`).join('\n'),

        quiz: (d) => (d.questions || []).map((q, i) => [
            `**Q${i + 1}. ${q.question}**`,
            q.options.map((o, oi) => `- ${'ABCDEF'[oi]}. ${o}${oi === q.answer_index ? ' ✓' : ''}`).join('\n'),
            has(q.explanation) && `> ${q.explanation}`,
        ].filter(Boolean).join('\n\n')).join('\n\n'),
    };

    function buildReport() {
        const info = state.info;
        const title = $('#paperTitle').textContent;
        const authors = $('#paperAuthors').textContent;
        const parts = [
            `# ${title}`,
            [authors && `**Authors:** ${authors}`, `**Source file:** ${info.filename}`, `**Generated by PaperMind** on ${new Date().toLocaleDateString()}`]
                .filter(Boolean).join('  \n'),
        ];
        SECTIONS.filter((s) => state.results[s]).forEach((s) => parts.push(`## ${LABELS[s]}\n\n${TO_MARKDOWN[s](state.results[s])}`));
        if (state.chat.length) {
            parts.push(`## Q&A\n\n${state.chat.map((c) => `**Q: ${c.question}**\n\n${c.answer}${
                c.quotes && c.quotes.length ? `\n\n${c.quotes.map((q) => `> "${q}"`).join('\n>\n')}` : ''}`).join('\n\n---\n\n')}`);
        }
        return `${parts.join('\n\n')}\n`;
    }

    function exportMarkdown() {
        if (!SECTIONS.some((s) => state.results[s]) && !state.chat.length) {
            toast('Run at least one analysis before exporting');
            return;
        }
        const slug = $('#paperTitle').textContent.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'paper';
        const url = URL.createObjectURL(new Blob([buildReport()], { type: 'text/markdown' }));
        el('a', { href: url, download: `papermind-${slug}.md` }).click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        toast('Report downloaded');
    }

    function printReport() {
        if (!SECTIONS.some((s) => state.results[s])) {
            toast('Run at least one analysis before printing');
            return;
        }
        $('#printTitle').textContent = $('#paperTitle').textContent;
        $('#printMeta').textContent = [$('#paperAuthors').textContent, `Analyzed with PaperMind · ${new Date().toLocaleDateString()}`]
            .filter(Boolean).join(' — ');
        window.print();
    }

    // ---------- Chat ----------
    const chatLog = $('#chatLog');
    const chatInput = $('#chatQuestion');

    function resetChat() {
        state.chat = [];
        $$('.msg', chatLog).forEach((m) => m.remove());
        $('#chatEmpty').hidden = false;
    }

    function autoGrow() {
        chatInput.style.height = 'auto';
        chatInput.style.height = `${Math.min(chatInput.scrollHeight, 160)}px`;
    }

    function scrollChat() {
        chatLog.scrollTop = chatLog.scrollHeight;
    }

    async function ask(question) {
        question = question.trim();
        if (!question || state.chatBusy) return;
        const docId = state.docId;
        state.chatBusy = true;
        $('#chatEmpty').hidden = true;
        chatInput.value = '';
        autoGrow();

        chatLog.append(el('div', { class: 'msg user', text: question }));
        const reply = el('div', { class: 'msg bot' }, el('span', { class: 'typing', 'aria-label': 'Thinking' }, el('i'), el('i'), el('i')));
        chatLog.append(reply);
        scrollChat();

        try {
            const history = state.chat.map(({ question: q, answer: a }) => ({ question: q, answer: a }));
            const res = await api('/api/ask', { doc_id: docId, question, history });
            if (docId !== state.docId) return;
            const quotes = clean(res.quotes);
            state.chat.push({ question, answer: res.answer, quotes });
            reply.classList.toggle('unanswerable', res.answerable === false);
            reply.replaceChildren(
                el('div', { class: 'answer', text: res.answer }),
                ...quotes.map((q) => el('blockquote', { text: `“${q}”` })),
            );
        } catch (err) {
            if (docId !== state.docId || handleExpired(err)) return;
            reply.classList.add('error');
            reply.replaceChildren(el('div', { class: 'answer', text: err.message }));
        } finally {
            state.chatBusy = false;
            scrollChat();
        }
    }

    $('#chatForm').addEventListener('submit', (e) => {
        e.preventDefault();
        ask(chatInput.value);
    });
    chatInput.addEventListener('input', autoGrow);
    chatInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
            e.preventDefault();
            ask(chatInput.value);
        }
    });
    $$('[data-suggest]').forEach((b) => b.addEventListener('click', () => ask(b.textContent)));

    // ---------- Global actions ----------
    $$('.nav-item').forEach((b) => b.addEventListener('click', () => select(b.dataset.section, true)));

    const ACTIONS = {
        'analyze-all': analyzeAll,
        'export-md': exportMarkdown,
        print: printReport,
        'new-paper': () => {
            const hasWork = SECTIONS.some((s) => state.results[s]) || state.chat.length;
            if (hasWork && !confirm('Start over with a new paper? Export first if you want to keep this analysis.')) return;
            resetToLanding();
        },
        'dismiss-banner': () => banner(''),
    };
    document.addEventListener('click', (e) => {
        const target = e.target.closest('[data-action]');
        if (target && ACTIONS[target.dataset.action]) ACTIONS[target.dataset.action]();
    });

    $('#themeToggle').addEventListener('click', () => {
        const root = document.documentElement;
        const current = root.dataset.theme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
        const next = current === 'dark' ? 'light' : 'dark';
        root.dataset.theme = next;
        try { localStorage.setItem('pm-theme', next); } catch { /* storage unavailable */ }
    });

    // Warn early if the server has no API key configured.
    fetch('/api/health').then((r) => r.json()).then((h) => {
        if (!h.api_key_configured) banner('GEMINI_API_KEY is not configured on the server. Add it to .env and restart PaperMind to enable analysis.');
    }).catch(() => {});
})();
