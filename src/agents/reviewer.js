/**
 * Reviewer Worker 节点（四维审查员）
 *
 * 核心机制：
 * - 每个 Worker 通过 Send 拿到独立的 State 副本（含 task + rag 引用）
 * - Worker 先调用 code_search（CodeRAG 检索工具）拉取相关代码片段
 * - 再用 LLM 基于专属审查维度的 system prompt 做分析
 * - 输出结构化 JSON 审查结果，供 Synthesizer 汇总
 *
 * 四个维度的差异仅在 system prompt 和输出结构字段，检索逻辑完全一致
 */
import { HumanMessage, SystemMessage, ToolMessage } from '@langchain/core/messages';
import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { llm } from '../config.js';
import { trace } from '../agent-trace.js';
import { formatSearchResults } from '../tools/code-rag.js';

// ======================================================================
// 各维度专属 System Prompt
// ======================================================================
const DIMENSION_PROMPTS = {
  quality: {
    role: '代码质量审查员',
    focus: '命名规范、注释完整度、代码风格、模块解耦、重复代码、单一职责、SOLID 原则',
    criteria: [
      '函数 / 变量命名是否语义化（避免 a1/b2/tmp 等无意义命名）',
      '关键逻辑是否有注释说明意图，复杂算法是否补充原理',
      '是否存在大函数（>100 行）违反单一职责',
      '是否有明显重复代码可抽取复用',
      '模块间耦合是否过高（大量跨模块直接访问内部变量）',
      '是否遵循项目统一的代码风格 / ESLint 规则',
    ],
  },
  bug: {
    role: '潜在 Bug 检测员',
    focus: '空指针访问、边界条件遗漏、异步竞态、资源泄露、异常处理缺失、类型不一致',
    criteria: [
      'null / undefined 未判空就直接访问属性',
      '数组越界、除零、空集合遍历',
      '异步回调 / Promise / async-await 链中是否漏 .catch 或 try-catch',
      'setTimeout / 定时器是否在组件卸载后清理（内存泄露）',
      '循环中修改正在遍历的集合',
      '资源（文件句柄、数据库连接、订阅）打开后是否在 finally 中释放',
      '函数返回类型在不同分支是否不一致',
    ],
  },
  perf: {
    role: '性能分析员',
    focus: '算法复杂度、不必要的拷贝、同步阻塞、缓存缺失、N+1 查询、热点路径',
    criteria: [
      '是否存在 O(N²) 或更差的嵌套循环（如对大数组做多次遍历）',
      '循环内是否有不必要的对象创建 / 深拷贝 / JSON.parse',
      'I/O 密集操作（文件读写、网络请求）是否同步阻塞',
      '高频调用函数是否缺少结果缓存（memoization）',
      '数据库查询是否可能产生 N+1 问题',
      '正则表达式是否有灾难性回溯风险',
      '大集合渲染 / 处理是否有分页 / 懒加载机制',
    ],
  },
  security: {
    role: '安全风险审查员',
    focus: '硬编码密钥、注入攻击、不安全反序列化、路径遍历、输入校验、依赖漏洞',
    criteria: [
      '是否有硬编码的 API Key / 密码 / Token / Secret',
      'SQL 查询是否拼接用户输入（SQL 注入风险）',
      'HTML 渲染是否直接插入未转义的用户输入（XSS 风险）',
      '文件上传 / 下载接口是否校验路径（路径遍历 ../ 风险）',
      '鉴权中间件是否覆盖所有敏感路由（越权访问风险）',
      '是否使用了 eval() / Function() 执行动态代码',
      '依赖库是否有已知高危漏洞（可建议运行 npm audit / pnpm audit）',
      '环境变量是否有默认值泄露敏感信息',
    ],
  },
};

// ======================================================================
// 构造 Code Search 工具
// 注意：rag 实例在 fan-out 前构建一次，所有 Worker 共享同一个引用
// ======================================================================
function buildCodeSearchTool(rag) {
  return new DynamicStructuredTool({
    name: 'code_search',
    description:
      '在代码仓库中按语义检索相关代码片段。需要定位某个函数实现、查找某段逻辑、分析模块间依赖时使用。返回片段含文件路径、行号、函数名和完整代码。',
    schema: z.object({
      query: z.string().describe('要检索的代码内容描述，如"用户鉴权逻辑"、"数据库初始化"、"错误处理"'),
      topK: z.number().optional().describe('返回条数，默认 5'),
    }),
    func: async ({ query, topK = 5 }) => {
      return formatSearchResults(rag, query, topK);
    },
  });
}

// ======================================================================
// 构造维度专属审查 System Prompt
// ======================================================================
function buildReviewPrompt(dimId, task) {
  const cfg = DIMENSION_PROMPTS[dimId] || DIMENSION_PROMPTS.quality;
  const focusText = task.focusAreas?.length
    ? `重点关注文件 / 模块：\n${task.focusAreas.map((f) => '  • ' + f).join('\n')}`
    : '无特别指定，扫描全仓库。';

  const criteriaText = cfg.criteria.map((c, i) => `  ${i + 1}. ${c}`).join('\n');

  return new SystemMessage(
    `你是${cfg.role}，正在对目标代码仓库做【${cfg.focus}】专项审查。

${focusText}

## 审查清单（逐条扫描）
${criteriaText}

## 工作方式
1. 先用 code_search 工具检索相关代码片段（建议围绕 focusAreas 做 2-3 次检索）
2. 找到具体问题后，记录：文件路径 + 起始行号 + 问题类型 + 问题描述 + 建议修复方案
3. 严重程度分级：🔴 Critical（必须修）/ 🟡 Major（建议修）/ 🔵 Minor（可优化）

## 输出格式（严格 JSON，不要其他文字）
\`\`\`json
{
  "dimension": "${dimId}",
  "dimensionName": "${cfg.role.replace('审查员', '审查')}",
  "summary": "总体评价（50-100 字）",
  "score": 7.5,
  "issues": [
    {
      "severity": "Critical|Major|Minor",
      "file": "src/utils/auth.js",
      "line": 42,
      "type": "问题类型",
      "description": "具体问题描述，含代码片段引用",
      "suggestion": "修复建议"
    }
  ],
  "goodPractices": ["值得肯定的做法 1", "值得肯定的做法 2"]
}
\`\`\``
  );
}

// ======================================================================
// Worker 主函数
// ======================================================================
export async function reviewerWorker(state) {
  const task = state.task;
  const rag = state.rag;
  const dim = task.dimension;

  console.log(`\n🔍 Reviewer [${task.dimensionName}]: 开始审查...`);
  console.log(`   focusAreas: ${task.focusAreas?.join(', ') || '通用全仓库'}`);

  // 绑定 code_search 工具
  const searchTool = buildCodeSearchTool(rag);
  const modelWithTools = llm.bindTools([searchTool]);

  // ---------- Step 1：让 LLM 调用 code_search 拉取相关代码 ----------
  const sysPrompt = buildReviewPrompt(dim, task);
  const userMsg = new HumanMessage(
    `请先调用 code_search 工具检索相关代码片段，再基于检索结果做 ${task.dimensionName} 审查。

建议检索关键词：
${task.focusAreas?.length ? task.focusAreas.map((f) => `  • "${f}" 相关逻辑`).join('\n') : '  • 核心业务逻辑\n  • 错误处理'}

至少检索 2-3 次覆盖不同关注点，然后输出最终 JSON 审查结果。`
  );

  const messages = [sysPrompt, userMsg];

  // ReAct 循环：最多 5 轮（防止无限 tool_call 循环）
  let currentResp;
  let turn = 0;
  const MAX_TURNS = 5;

  while (turn < MAX_TURNS) {
    // Trace：记录每轮 LLM 调用的输入输出、token 消耗、耗时
    currentResp = await trace.traceLLM(modelWithTools, `reviewer.${dim}.turn${turn + 1}`, messages);
    messages.push(currentResp);
    turn++;

    const toolCalls = currentResp?.tool_calls || [];
    if (toolCalls.length === 0) break;

    // 执行所有 tool_calls（本实现中只会有 code_search）
    for (const tc of toolCalls) {
      console.log(`   🛠️  [${task.dimensionName}] 调用 code_search: ${tc.args?.query?.slice(0, 60)}...`);
      const toolStart = Date.now();
      const toolResult = await searchTool.invoke(tc.args);
      // Trace：记录工具调用入参、结果、耗时
      trace.traceTool(`reviewer.${dim}.tool`, 'code_search', tc.args, toolResult, Date.now() - toolStart);
      messages.push(new ToolMessage({
        tool_call_id: tc.id,
        content: toolResult,
      }));
    }
  }

  // ---------- Step 2：解析审查结果（JSON） ----------
  const finalContent = currentResp?.content?.toString().trim() || '';
  let reviewResult;

  try {
    const jsonMatch = finalContent.match(/```json\s*([\s\S]*?)```/) || finalContent.match(/(\{[\s\S]*\})/);
    reviewResult = jsonMatch ? JSON.parse(jsonMatch[1].trim()) : JSON.parse(finalContent);
  } catch (err) {
    // 解析失败：降级为原始文本，外层 Synthesizer 可兜底
    console.log(`   ⚠️  JSON 解析失败，降级为原始文本: ${err.message}`);
    reviewResult = {
      dimension: dim,
      dimensionName: task.dimensionName,
      summary: 'LLM 输出解析失败',
      score: 0,
      issues: [],
      rawText: finalContent,
    };
  }

  // 补充 score 默认值
  if (typeof reviewResult.score !== 'number') reviewResult.score = 5;
  if (!reviewResult.issues) reviewResult.issues = [];

  const criticalCount = reviewResult.issues.filter((i) => i.severity === 'Critical').length;
  const majorCount = reviewResult.issues.filter((i) => i.severity === 'Major').length;
  console.log(`   ✅ [${task.dimensionName}] 审查完成：${reviewResult.issues.length} 个问题（🔴${criticalCount} 🟡${majorCount}）评分 ${reviewResult.score}/10`);

  // 返回给主图（worker_results 用 concat reducer 自动累积）
  return {
    worker_results: [{
      dimension: dim,
      dimensionName: task.dimensionName,
      review: reviewResult,
    }],
  };
}
