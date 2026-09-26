/**
 * Agent Trace 日志系统
 *
 * 记录每一步的：输入输出、Token 消耗、耗时
 * - LLM 调用：traceLLM() 包装任意 Runnable（llm / bindTools 后的模型），
 *   自动从响应中提取 usage_metadata（OpenAI 兼容格式）
 * - 工具调用：traceTool() 记录 code_search 等工具的入参与结果
 * - 流程节点：trace.step() 记录 clone / index 等非 LLM 步骤
 *
 * 落盘格式：traces/trace-<时间戳>.jsonl（每行一条 JSON，便于 grep / 程序化分析）
 * 同步产出：reports/<日期>-agent-cost-analysis.md（成本分布 / 瓶颈 Top / 上下文膨胀分析）
 * 全局单例：一次进程运行 = 一份完整 trace
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TRACES_DIR = path.resolve(__dirname, '../traces');
const REPORTS_DIR = path.resolve(__dirname, '../reports');
const PROJECT_ROOT = path.resolve(__dirname, '..');

// 单条 input/output 最大记录长度，防止 trace 文件膨胀
const MAX_CONTENT_LENGTH = 3000;

/** 递归截断过长的字符串字段 */
function truncateValue(value) {
  if (typeof value === 'string') {
    return value.length > MAX_CONTENT_LENGTH
      ? value.slice(0, MAX_CONTENT_LENGTH) + `...[截断，共 ${value.length} 字符]`
      : value;
  }
  if (Array.isArray(value)) return value.map(truncateValue);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = truncateValue(v);
    return out;
  }
  return value;
}

/** 序列化输入：兼容 LangChain 消息对象 / 字符串 / 普通对象 / 数组 */
function serializeInput(messages) {
  const one = (m) => {
    if (typeof m === 'string') return m;
    if (Array.isArray(m)) return m.map(one);
    // LangChain BaseMessage（有 getType 方法）
    if (m && typeof m === 'object' && typeof m.getType === 'function') {
      const item = {
        role: m.getType(),
        content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
      };
      if (m.tool_calls?.length) {
        item.tool_calls = m.tool_calls.map((tc) => ({ name: tc.name, args: tc.args }));
      }
      if (m.tool_call_id) item.tool_call_id = m.tool_call_id;
      return item;
    }
    // 普通对象（如 runMeta / 工具入参）原样保留
    return m;
  };
  return Array.isArray(messages) ? messages.map(one) : one(messages);
}

/** 从 LLM 响应中提取 token 用量（优先 usage_metadata，回退 response_metadata） */
function extractTokenUsage(response) {
  const u = response?.usage_metadata;
  if (u) {
    return { input: u.input_tokens, output: u.output_tokens, total: u.total_tokens };
  }
  const t = response?.response_metadata?.tokenUsage;
  if (t) {
    return { input: t.promptTokens ?? 0, output: t.completionTokens ?? 0, total: t.totalTokens ?? 0 };
  }
  return null;
}

/** 步骤名归一化：reviewer.<dim>.turnN / .tool 归并到所属类别 */
function categoryOf(name) {
  if (name === 'clone') return 'clone（克隆仓库）';
  if (name === 'index') return 'index（RAG 索引构建）';
  if (name === 'orchestrator.plan') return 'orchestrator.plan（任务编排）';
  if (/^reviewer\.[^.]+\.turn\d+$/.test(name)) return 'reviewer LLM（四维审查推理）';
  if (/^reviewer\.[^.]+\.tool$/.test(name)) return 'reviewer.tool（code_search 检索）';
  if (name === 'synthesizer.executive-summary') return 'synthesizer（报告汇总）';
  return name;
}

class AgentTrace {
  constructor() {
    this.records = [];     // 内存中的全部记录（用于结尾汇总统计）
    this.filePath = null;  // JSONL 文件路径（首次写入时才创建，避免 import 副作用）
    this.runMeta = {};     // 运行元信息（githubUrl 等，写入 run.summary）
  }

  /** 懒加载 - 初始化 trace 文件 */
  _ensureFile() {
    if (this.filePath) return;
    fs.mkdirSync(TRACES_DIR, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    this.filePath = path.join(TRACES_DIR, `trace-${ts}.jsonl`);
  }

  /** 记录一条 trace（终端简报 + JSONL 落盘） */
  step({ name, input, output, tokens, durationMs, meta }) {
    const record = {
      ts: new Date().toISOString(),
      name,
      durationMs: durationMs ?? null,
      tokens: tokens ?? null,
      ...(meta || {}),
      input: input !== undefined ? truncateValue(serializeInput(input)) : undefined,
      output: output !== undefined ? truncateValue(output) : undefined,
    };
    this.records.push(record);

    // 落盘失败不影响主流程
    try {
      this._ensureFile();
      fs.appendFileSync(this.filePath, JSON.stringify(record) + '\n');
    } catch { /* ignore */ }

    // 终端简报：步骤名 | 耗时 | token 输入→输出(总计)
    const tokenStr = tokens ? `tokens ${tokens.input}→${tokens.output}(共${tokens.total})` : 'tokens -';
    console.log(`  📝 [trace] ${name} | ${durationMs ?? '-'}ms | ${tokenStr}`);
    return record;
  }

  /**
   * 包装一次 LLM / Runnable 调用（llm.invoke 或 bindTools 后的模型均可）
   * 自动记录：输入消息、输出内容 + tool_calls、token 消耗、耗时；异常也记录后原样抛出
   */
  async traceLLM(runnable, name, messages) {
    const start = Date.now();
    try {
      const response = await runnable.invoke(messages);
      this.step({
        name,
        input: messages,
        output: {
          content: typeof response.content === 'string' ? response.content : JSON.stringify(response.content),
          ...(response.tool_calls?.length
            ? { tool_calls: response.tool_calls.map((tc) => ({ name: tc.name, args: tc.args })) }
            : {}),
        },
        tokens: extractTokenUsage(response),
        durationMs: Date.now() - start,
      });
      return response;
    } catch (err) {
      this.step({
        name,
        input: messages,
        output: `ERROR: ${err.message}`,
        tokens: null,
        durationMs: Date.now() - start,
        meta: { error: true },
      });
      throw err;
    }
  }

  /** 记录一次工具调用（如 code_search） */
  traceTool(name, toolName, args, result, durationMs) {
    return this.step({
      name,
      input: { tool: toolName, args },
      output: result,
      tokens: null,
      durationMs,
      meta: { type: 'tool_call' },
    });
  }

  /** 聚合记录：按类别 / 维度 / Top 榜 / 每轮输入膨胀（供成本报告使用） */
  _aggregate() {
    const steps = this.records.filter((r) => r.name !== 'run.summary' && r.name !== 'run.start');
    const byCat = {};
    const byDim = {};
    const turnGrowth = {};

    for (const s of steps) {
      const cat = categoryOf(s.name);
      (byCat[cat] ??= { count: 0, tokenTotal: 0, durMs: 0 });
      byCat[cat].count++;
      byCat[cat].tokenTotal += s.tokens?.total || 0;
      byCat[cat].durMs += s.durationMs || 0;

      const turnMatch = s.name.match(/^reviewer\.([^.]+)\.turn(\d+)$/);
      const toolMatch = s.name.match(/^reviewer\.([^.]+)\.tool$/);
      if (turnMatch) {
        const dim = (byDim[turnMatch[1]] ??= { turns: 0, toolCalls: 0, tokenTotal: 0, llmDurMs: 0 });
        dim.turns++;
        dim.tokenTotal += s.tokens?.total || 0;
        dim.llmDurMs += s.durationMs || 0;
        (turnGrowth[turnMatch[1]] ??= []).push({ turn: +turnMatch[2], input: s.tokens?.input || 0 });
      } else if (toolMatch) {
        const dim = (byDim[toolMatch[1]] ??= { turns: 0, toolCalls: 0, tokenTotal: 0, llmDurMs: 0 });
        dim.toolCalls++;
      }
    }

    const topTok = steps
      .filter((s) => s.tokens)
      .sort((a, b) => (b.tokens.total || 0) - (a.tokens.total || 0))
      .slice(0, 5);
    const topDur = [...steps]
      .sort((a, b) => (b.durationMs || 0) - (a.durationMs || 0))
      .slice(0, 5);

    return { byCat, byDim, turnGrowth, topTok, topDur };
  }

  /** 生成成本分析 Markdown 报告（与 trace JSONL 同步落盘），返回报告路径 */
  _writeCostReport(stats) {
    const { byCat, byDim, turnGrowth, topTok, topDur } = this._aggregate();
    const reviewerTokens = byCat['reviewer LLM（四维审查推理）']?.tokenTotal || 0;
    const reviewerDur = byCat['reviewer LLM（四维审查推理）']?.durMs || 0;
    const fmt = (n) => Number(n || 0).toLocaleString('en-US');
    const pct = (part, total) => (total > 0 ? ((part / total) * 100).toFixed(1) + '%' : '0%');
    const relTrace = this.filePath ? path.relative(PROJECT_ROOT, this.filePath) : 'N/A';

    let md = '';
    md += `# Agent 运行成本分析报告\n\n`;
    md += `> **分析对象**: ${this.runMeta.githubUrl || 'N/A'}\n`;
    md += `> **数据来源**: ${relTrace}（${this.records.length} 条记录）\n`;
    md += `> **生成时间**: ${new Date().toISOString().slice(0, 19).replace('T', ' ')}\n\n`;
    md += `---\n\n`;

    // 一、运行总览
    const llmCalls = this.records.filter((r) => r.tokens).length;
    const toolCalls = this.records.filter((r) => r.type === 'tool_call').length;
    md += `## 一、运行总览\n\n`;
    md += `| 指标 | 数值 |\n|------|------|\n`;
    md += `| Token 总消耗 | **${fmt(stats.tokenTotal)}**（输入 ${fmt(stats.tokenInput)} / 输出 ${fmt(stats.tokenOutput)}） |\n`;
    md += `| LLM 调用次数 | ${llmCalls} 次 |\n`;
    md += `| 工具调用（code_search） | ${toolCalls} 次（本地计算，0 Token） |\n`;
    md += `| 累计耗时 | **${(stats.totalDurationMs / 1000).toFixed(1)}s**（多 Worker 并行，实际墙钟时间 < 此值） |\n`;
    md += `| 步骤总数 | ${stats.totalSteps} |\n\n`;

    // 二、成本分布（按步骤类别，Token 降序）
    md += `## 二、成本分布（按步骤类别）\n\n`;
    md += `| 步骤类别 | 次数 | Token | Token 占比 | 耗时 | 耗时占比 |\n`;
    md += `|----------|------|-------|-----------|------|---------|\n`;
    for (const [cat, v] of Object.entries(byCat).sort((a, b) => b[1].tokenTotal - a[1].tokenTotal)) {
      md += `| ${cat} | ${v.count} | ${fmt(v.tokenTotal)} | ${pct(v.tokenTotal, stats.tokenTotal)} | ${(v.durMs / 1000).toFixed(1)}s | ${pct(v.durMs, stats.totalDurationMs)} |\n`;
    }
    md += `\n**结论**：成本集中在 Reviewer 的 ReAct 推理循环；code_search 本地检索不耗 Token，但其返回结果追加进上下文，是 Token 膨胀的间接推手。\n\n`;

    // 三、审查维度对比（有 reviewer 记录才输出）
    if (Object.keys(byDim).length > 0) {
      md += `## 三、审查维度对比\n\n`;
      md += `| 维度 | LLM 轮数 | 检索次数 | Token 总耗 | Token 占比* | LLM 耗时 | 耗时占比* |\n`;
      md += `|------|---------|---------|-----------|------------|---------|----------|\n`;
      for (const [dim, v] of Object.entries(byDim).sort((a, b) => b[1].tokenTotal - a[1].tokenTotal)) {
        md += `| ${dim} | ${v.turns} | ${v.toolCalls} | ${fmt(v.tokenTotal)} | ${pct(v.tokenTotal, reviewerTokens)} | ${(v.llmDurMs / 1000).toFixed(1)}s | ${pct(v.llmDurMs, reviewerDur)} |\n`;
      }
      md += `\n*占 reviewer LLM 总量（${fmt(reviewerTokens)} Token / ${(reviewerDur / 1000).toFixed(1)}s）的百分比\n\n`;
      md += `**关键规律**：检索次数直接决定成本 —— 每多一次检索，下一轮输入就多 ~5K~20K Token。\n\n`;
    }

    // 四、瓶颈定位
    md += `## 四、瓶颈定位\n\n`;
    md += `### 4.1 单步 Top5（烧 Token）\n\n`;
    md += `| 排名 | 步骤 | 输入 | 输出 | 合计 | 耗时 |\n|------|------|------|------|------|------|\n`;
    topTok.forEach((s, i) => {
      md += `| ${i + 1} | ${s.name} | ${fmt(s.tokens.input)} | ${fmt(s.tokens.output)} | **${fmt(s.tokens.total)}** | ${((s.durationMs || 0) / 1000).toFixed(1)}s |\n`;
    });

    md += `\n### 4.2 单步 Top5（最慢）\n\n`;
    md += `| 排名 | 步骤 | 耗时 | Token |\n|------|------|------|-------|\n`;
    topDur.forEach((s, i) => {
      md += `| ${i + 1} | ${s.name} | ${((s.durationMs || 0) / 1000).toFixed(1)}s | ${s.tokens ? fmt(s.tokens.total) : '-'} |\n`;
    });

    // 4.3 上下文膨胀表（有 reviewer 轮次才输出）
    const dims = Object.keys(turnGrowth);
    if (dims.length > 0) {
      const maxTurn = Math.max(...dims.flatMap((d) => turnGrowth[d].map((t) => t.turn)));
      md += `\n### 4.3 根因：上下文线性膨胀（各轮输入 Token）\n\n`;
      md += `| 维度 | ${Array.from({ length: maxTurn }, (_, i) => `turn${i + 1}`).join(' | ')} | 首轮检索注入 |\n`;
      md += `|------|${Array.from({ length: maxTurn }, () => '------').join('|')}|------|\n`;
      for (const dim of dims) {
        const turns = turnGrowth[dim];
        const cells = Array.from({ length: maxTurn }, (_, i) => {
          const t = turns.find((x) => x.turn === i + 1);
          return t ? fmt(t.input) : '-';
        });
        const jump = turns.length >= 2 ? `+${fmt(turns[1].input - turns[0].input)}` : '-';
        md += `| ${dim} | ${cells.join(' | ')} | ${jump} |\n`;
      }
      md += `\n每次 code_search 返回的片段全量追加进 messages，导致下一轮输入线性上涨；中间轮次仅输出 tool_call（~200 Token）却消耗上万输入 Token。\n\n`;
    }

    // 五、优化建议 + 换算公式
    md += `## 五、优化建议（P0）\n\n`;
    md += `1. **压缩工具返回**：code_search 的 topK 5→3、片段截断至 ~40 行（输入 Token 降 40~60%）\n`;
    md += `2. **限制检索预算**：每维度最多 2~3 次检索，或累计输入超 25K 强制转入产出\n\n`;
    md += `---\n\n`;
    md += `## 附：成本换算公式\n\n`;
    md += '```\n';
    md += `本次运行成本 ≈ ${(stats.tokenInput / 1e6).toFixed(3)}M × 输入单价 + ${(stats.tokenOutput / 1e6).toFixed(3)}M × 输出单价\n`;
    md += '```\n';

    // 同日重复运行覆盖当日报告（最新一次为准）
    fs.mkdirSync(REPORTS_DIR, { recursive: true });
    const date = new Date().toISOString().slice(0, 10);
    const reportPath = path.join(REPORTS_DIR, `${date}-agent-cost-analysis.md`);
    fs.writeFileSync(reportPath, md, 'utf-8');
    return reportPath;
  }

  /** 运行结束汇总：同步生成成本分析报告 + 写入 run.summary 记录，返回统计数据 */
  summary() {
    const stats = {
      totalSteps: this.records.length,
      errorCount: this.records.filter((r) => r.error).length,
      tokenInput: this.records.reduce((s, r) => s + (r.tokens?.input || 0), 0),
      tokenOutput: this.records.reduce((s, r) => s + (r.tokens?.output || 0), 0),
      tokenTotal: this.records.reduce((s, r) => s + (r.tokens?.total || 0), 0),
      totalDurationMs: this.records.reduce((s, r) => s + (r.durationMs || 0), 0),
      traceFile: this.filePath,
    };

    // 与 trace 文件同步生成成本分析报告（失败不影响 trace 落盘）
    try {
      stats.costReportFile = this._writeCostReport(stats);
    } catch (err) {
      console.log(`  ⚠️ [trace] 成本报告生成失败: ${err.message}`);
    }

    this.step({ name: 'run.summary', input: this.runMeta, output: stats, tokens: null, durationMs: null });
    return stats;
  }
}

// 全局单例：一次进程运行 = 一份完整 trace
export const trace = new AgentTrace();
