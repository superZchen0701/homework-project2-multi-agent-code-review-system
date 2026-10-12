# Multi-Agent Code Review System

A GitHub repository code review system built on **LangGraph** + **Code RAG**. Input a repo URL and get an end-to-end pipeline: clone → index → 4-dimension parallel review → structured Markdown report.

## ✨ Features

- 🔀 **Multi-Agent Collaboration**: Pipeline backbone + Orchestrator-Worker fan-out. Four specialized Review Agents run in parallel.
- 🧬 **Code RAG**: AST-aware chunking + semantic vector retrieval lets Agents pinpoint relevant code instead of scanning everything.
- 🎯 **4 Review Dimensions**: Code Quality / Potential Bugs / Performance / Security — covering the most common code defects.
- 📄 **Structured Reports**: Auto-generated Markdown with score dashboard, issue lists, and fix suggestions.
- 📊 **Trace Logging**: Records every step's input/output, token usage, and latency; writes JSONL and auto-generates a cost analysis report.

## 🏗️ Architecture

```mermaid
flowchart TD
    A([GitHub URL]) --> B[clone\nShallow clone to repos/]
    B --> C[index\nAST chunk + Embedding\nBuild vector index]
    C --> D[orchestrator\nAnalyze repo overview\nEmit 4 review tasks]
    D --> E1[quality\n✨ Code Quality]
    D --> E2[bug\n🐛 Potential Bugs]
    D --> E3[perf\n⚡ Performance]
    D --> E4[security\n🔒 Security]
    E1 --> F{synthesizer\nCompile report}
    E2 --> F
    E3 --> F
    E4 --> F
    F --> G([Markdown Report])

    style D fill:#f9a,stroke:#333
    style E1 fill:#ffd,stroke:#333
    style E2 fill:#ffd,stroke:#333
    style E3 fill:#ffd,stroke:#333
    style E4 fill:#ffd,stroke:#333
    style F fill:#9f9,stroke:#333
```

### Key Design Decisions

| Module | Tech | Notes |
|--------|------|-------|
| Orchestration | `@langchain/langgraph` | StateGraph + `Send` for dynamic fan-out |
| LLM | DeepSeek Chat | Agent reasoning / review / report writing |
| Embedding | Zhipu BigModel embedding-3 | Code chunk vectorization |
| AST Chunking | `@babel/parser` | Function/class-level semantic slices |
| Vector Store | In-memory array + cosine similarity | Zero external dependencies |

### LangGraph State Flow

```
START → clone → index → orchestrator ─┬─→ reviewerWorker × 4 (parallel) → synthesizer → END
                                      │
                                      └─ concat reducer accumulates 4-way results
```

- **`Send` fan-out**: Orchestrator produces 4 subtasks at runtime; the router generates an isolated State copy for each.
- **Shared RAG instance**: `CodeRAG.buildIndex()` runs once in `indexNode`; all 4 Workers share the same in-memory vector store via a single object reference.
- **Concat reducer**: `worker_results` uses a concat reducer so parallel worker results accumulate without overwriting each other.

## 📁 Project Structure

```
.
├── src/
│   ├── index.js               # Entry point: CLI parsing + report writer + trace summary
│   ├── config.js              # DeepSeek + Zhipu Embedding config
│   ├── graph.js               # LangGraph workflow assembly
│   ├── agent-trace.js         # Trace logging: per-step records + cost report generation
│   ├── tools/
│   │   ├── git-clone.js       # GitHub shallow clone
│   │   └── code-rag.js        # AST chunking + vector index + semantic search
│   └── agents/
│       ├── orchestrator.js    # Task decomposition (fixed 4 dimensions)
│       ├── reviewer.js        # Review Worker (ReAct: tool_call → review)
│       └── synthesizer.js     # Markdown report compilation
├── reports/                   # Review report + cost analysis report output
├── traces/                    # Agent Trace JSONL logs (.gitignore)
├── repos/                     # Runtime-cloned repos (.gitignore)
├── .env                       # Real API keys (.gitignore)
├── .env.example               # Env var template
└── package.json               # pnpm + 10 deps
```

## 🚀 Quick Start

### 1. Install dependencies

```bash
pnpm install
```

### 2. Configure environment variables

```bash
cp .env.example .env
# Edit .env with real API keys
```

```env
# DeepSeek (Agent reasoning)
DEEPSEEK_API_KEY=sk-xxxxxxxx
DEEPSEEK_BASE_URL=https://api.deepseek.com
DEEPSEEK_MODEL=deepseek-chat

# Zhipu BigModel (Code vectorization)
BIGMODEL_EMBEDDING_API_URL=https://open.bigmodel.cn/api/paas/v4/embeddings
BIGMODEL_EMBEDDING_API_KEY=xxxxxxxx
```

### 3. Run a review

```bash
pnpm start https://github.com/superZchen0701/homework-project1-personal-agent.git
```

### 4. View the reports

```bash
ls reports/
# 2026-09-23-superZchen0701-review.md        ← review report
# 2026-09-26-agent-cost-analysis.md          ← cost analysis report (auto-generated)
ls traces/
# trace-2026-09-26T03-23-42.jsonl            ← Agent trace log
```

## 📊 Trace Logging & Cost Analysis

Every run records a full-pipeline trace; a summary is printed at the end (step count / token totals / cumulative latency / file paths):

| Recorder | What it captures |
|----------|------------------|
| `traceLLM` | Wraps each LLM call: input messages, output content + tool_calls, tokens (`usage_metadata`), latency; errors are recorded then rethrown |
| `traceTool` | code_search args, result, latency (local retrieval, 0 tokens) |
| `trace.step` | Non-LLM steps (clone / index) latency and artifacts |
| `summary()` | Aggregate stats + synchronized cost report generation |

- **JSONL output**: `traces/trace-<timestamp>.jsonl`, one JSON record per line; fields over 3000 chars are truncated
- **Cost analysis report**: `reports/<date>-agent-cost-analysis.md` — cost breakdown (per step category / review dimension), single-step token & latency Top5, context bloat table, P0 optimization suggestions; same-day runs overwrite the daily report (latest wins)
- Analysis angles: which step burns the most tokens / is the slowest, and how retrieval rounds map to token growth

## 🎯 Review Dimensions

| Dimension | Focus | Checklist |
|-----------|-------|-----------|
| ✨ Code Quality | Style / Design | Semantic naming, single responsibility, SOLID, DRY, documentation |
| 🐛 Potential Bugs | Correctness | null checks, boundary conditions, async race, resource cleanup, type consistency |
| ⚡ Performance | Efficiency | O(N²) loops, object creation in loops, N+1 queries, missing caching, catastrophic regex |
| 🔒 Security Risks | Vulnerabilities | Hardcoded secrets, SQL injection, XSS/CSRF, path traversal, `eval()` dynamic code |

Per-Reviewer workflow:

```
1. Call code_search tool 2-3 times to fetch relevant code snippets
2. Walk the checklist with the dimension-specific system prompt
3. Emit structured JSON (severity 🔴🟡🔵, file path, line, fix suggestion)
```

## 🧠 Why Code RAG?

Traditional full-repo code review by LLM has two hard problems:
1. **Context window overflow** — dozens of source files blow past the model's context limit.
2. **Attention dilution** — LLM accuracy drops sharply when searching for issues across long, unstructured text.

Code RAG solves both:
```
AST parse → function/class chunks → Embedding → Vector index → Semantic search → Targeted snippets in prompt
```

- `@babel/parser` slices source into function-level blocks with clear semantic boundaries.
- Zhipu `embedding-3` vectorizes each chunk.
- Reviewers pull exactly what they need via `code_search(query, topK)`.

## 🔧 Tech Stack

| Category | Choice | Version |
|----------|--------|---------|
| Runtime | Node.js | ≥ 18 |
| Package manager | pnpm | ≥ 9 |
| LangGraph | `@langchain/langgraph` | ^1.4 |
| LangChain | `@langchain/core` / `@langchain/openai` | ^1.2 |
| AST | `@babel/parser` | ^8 |
| Schema | `zod` | ^4 |
| LLM | DeepSeek Chat | deepseek-chat |
| Embedding | Zhipu BigModel | embedding-3 |

## 📝 Report Format

```markdown
# 🔍 Code Review Report

## 🎯 Executive Summary          ← LLM-generated
## 📊 Overview                    ← Score dashboard
   | Dimension | Score | 🔴 | 🟡 | 🔵 | Total |
## 🚨 Critical Issues             ← Must-fix
## 📝 Dimension Details
   ### ✨ Code Quality
   ### 🐛 Potential Bugs
   ### ⚡ Performance
   ### 🔒 Security
## 🎯 Top Fix Priorities
```

## 📌 Notes

- Repos are cloned with `--depth 1` shallow clone for speed.
- Max 200 code files indexed per repo to avoid Embedding API quota blow-ups.
- Non-JS/TS files fall back to line-based chunking (60 lines/block, 10-line overlap).
- Empty repos / repos with no code files are guarded — no wasted Embedding calls.
- `.env`, `repos/`, `traces/`, and `screenshots/` are all in `.gitignore`.
- The cost report is named by day — same-day runs overwrite it (trace JSONLs are never overwritten and remain fully traceable).

## 📄 License

MIT
