/**
 * LangGraph 工作流组装
 *
 * 图结构：
 *
 *   START → cloneNode → indexNode → orchestratorNode →(Send 扇出)
 *                                                       ↓
 *                                              reviewerWorker × 4（并行）
 *                                                       ↓
 *                                              synthesizerNode → END
 *
 * 关键设计：
 *   - RAG 单例：CodeRAG 实例在 indexNode 构建一次，整个图生命周期内共享（Worker 通过 Send 独立 State 副本传入引用）
 *   - Send 动态扇出：orchestratorNode 产出 4 个 subtasks → 路由函数为每个生成 Send
 *   - concat reducer：worker_results 用 concat reducer，4 个并行 Worker 的结果自动累积不覆盖
 *   - Pipeline 主干：clone → index → orchestrator → fanout → synthesize，线性主流程清晰可预测
 */
import { StateGraph, START, END, Annotation, Send } from '@langchain/langgraph';
import fs from 'fs';

import { cloneRepo } from './tools/git-clone.js';
import { CodeRAG } from './tools/code-rag.js';
import { orchestratorNode } from './agents/orchestrator.js';
import { reviewerWorker } from './agents/reviewer.js';
import { synthesizerNode } from './agents/synthesizer.js';

// ======================================================================
// 主图 State
// ======================================================================
const ReviewState = Annotation.Root({
  // --- 输入 ---
  githubUrl: Annotation(), // GitHub 仓库地址
  // --- cloneNode 产出 ---
  repoPath: Annotation(),  // 本地克隆路径
  repoName: Annotation(),  // owner-repo 格式名
  // --- indexNode 产出 ---
  rag: Annotation(),       // CodeRAG 实例（共享引用）
  // --- orchestratorNode 产出 ---
  subtasks: Annotation({   // 4 个审查维度任务
    reducer: (_, update) => update, // 整体覆盖
    default: () => [],
  }),
  // --- reviewerWorker 产出（concat reducer） ---
  worker_results: Annotation({
    reducer: (old, update) => [...(old || []), ...(update || [])],
    default: () => [],
  }),
  // --- synthesizerNode 产出 ---
  markdown: Annotation(),
  reviewSummary: Annotation(),
});

// Worker 独立 State（Send 扇出时复制，与主图隔离）
const WorkerState = Annotation.Root({
  task: Annotation(),      // 当前 Worker 负责的子任务
  rag: Annotation(),       // CodeRAG 引用（共享同一个实例）
  worker_results: Annotation({
    reducer: (old, update) => [...(old || []), ...(update || [])],
    default: () => [],
  }),
});

// ======================================================================
// Pipeline 前置节点
// ======================================================================

/** Clone 节点：GitHub URL → 本地仓库 */
async function cloneNode(state) {
  console.log('\n📥 [clone] 开始克隆仓库...');
  const { localPath, repoName } = cloneRepo(state.githubUrl);
  return { repoPath: localPath, repoName };
}

/** Index 节点：本地仓库 → CodeRAG 向量索引 */
async function indexNode(state) {
  console.log('\n🏗️  [index] 构建 CodeRAG 索引...');
  const rag = new CodeRAG(state.repoPath);
  await rag.buildIndex();
  return { rag };
}

// ======================================================================
// 路由：Send 动态扇出
// ======================================================================
function fanoutToReviewers(state) {
  const subtasks = state.subtasks || [];
  console.log(`\n📡 扇出 ${subtasks.length} 个 Reviewer Worker 并行执行...`);

  // 为每个子任务生成一个 Send，携带独立 State 副本 + 共享 rag 引用
  return subtasks.map((task) =>
    new Send('reviewerWorker', {
      task,
      rag: state.rag, // 注意：同一个对象引用，Worker 间共享索引
    })
  );
}

// ======================================================================
// 组装工作流
// ======================================================================
function buildGraph() {
  const workflow = new StateGraph(ReviewState)
    // --- 节点 ---
    .addNode('clone', cloneNode)
    .addNode('index', indexNode)
    .addNode('orchestrator', orchestratorNode)
    // reviewerWorker 用独立 State schema
    .addNode('reviewerWorker', reviewerWorker, WorkerState)
    .addNode('synthesizer', synthesizerNode)

    // --- 边 ---
    // 主干流水线：START → clone → index → orchestrator
    .addEdge(START, 'clone')
    .addEdge('clone', 'index')
    .addEdge('index', 'orchestrator')

    // 条件边 + Send 扇出：orchestrator → 并行 N 个 reviewerWorker
    .addConditionalEdges('orchestrator', fanoutToReviewers, ['reviewerWorker'])

    // 所有 Worker 完成后 → synthesizer 汇总
    .addEdge('reviewerWorker', 'synthesizer')

    // 汇总完 → END
    .addEdge('synthesizer', END);

  return workflow.compile();
}

export function createReviewApp() {
  return buildGraph();
}
