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
 * 全局单例：一次进程运行 = 一份完整 trace
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TRACES_DIR = path.resolve(__dirname, '../traces');

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

  /** 运行结束汇总：写入最后一条 run.summary 记录，并返回统计数据 */
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
    this.step({ name: 'run.summary', input: this.runMeta, output: stats, tokens: null, durationMs: null });
    return stats;
  }
}

// 全局单例：一次进程运行 = 一份完整 trace
export const trace = new AgentTrace();
