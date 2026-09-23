/**
 * Orchestrator 节点（主编排者）
 *
 * 职责：
 * 1. 接收 repoPath（已构建好 CodeRAG 索引）
 * 2. 用 LLM 基于仓库概况，生成审查维度清单
 * 3. 输出 subtasks，供下游 fan-out 为 4 个并行 Reviewer Worker
 *
 * 本实现采用"固定 4 维度"策略（代码质量 / Bug / 性能 / 安全），
 * 维度由代码定义而非 LLM 动态决定 —— 保证覆盖完整的审查范围。
 * LLM 仅用于填充每个维度的"审查重点"（仓库特有文件 / 模块）。
 */
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { llm } from '../config.js';
import fs from 'fs';
import path from 'path';

/**
 * 读取仓库概况：package.json、README、目录结构前两层
 * 这些信息帮助 Orchestrator 精准定位每个审查维度的重点模块
 */
function getRepoOverview(repoPath) {
  const parts = [];

  // 1. package.json（如果是 Node 项目）
  const pkgPath = path.join(repoPath, 'package.json');
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
      parts.push(
        `【package.json】\n` +
        `name: ${pkg.name || 'N/A'}\n` +
        `description: ${pkg.description || 'N/A'}\n` +
        `main: ${pkg.main || 'N/A'}\n` +
        `scripts: ${pkg.scripts ? Object.keys(pkg.scripts).join(', ') : 'N/A'}\n` +
        `dependencies: ${pkg.dependencies ? Object.keys(pkg.dependencies).slice(0, 15).join(', ') : 'N/A'}`
      );
    } catch { /* 非 JSON 包 */ }
  }

  // 2. README（前 2000 字符）
  for (const name of ['README.md', 'README', 'readme.md']) {
    const p = path.join(repoPath, name);
    if (fs.existsSync(p)) {
      const content = fs.readFileSync(p, 'utf-8').slice(0, 2000);
      parts.push(`【README 摘要】\n${content}`);
      break;
    }
  }

  // 3. 目录结构（前两层）
  const dirTree = listDirTree(repoPath, 2);
  parts.push(`【目录结构】\n${dirTree}`);

  return parts.join('\n\n');
}

/** 简易目录树（跳过 .git / node_modules / dist / build） */
function listDirTree(root, maxDepth = 2) {
  const skip = new Set(['.git', 'node_modules', 'dist', 'build', '.next']);
  const lines = [];

  const walk = (dir, depth, prefix) => {
    if (depth > maxDepth) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (skip.has(entry.name)) continue;
      lines.push(prefix + entry.name + (entry.isDirectory() ? '/' : ''));
      if (entry.isDirectory()) {
        walk(path.join(dir, entry.name), depth + 1, prefix + '  ');
      }
    }
  };
  walk(root, 0, '');
  return lines.slice(0, 100).join('\n');
}

// ======================================================================
// 固定 4 审查维度定义（LLM 不需要"决定"维度，只需填充重点）
// ======================================================================
const REVIEW_DIMENSIONS = [
  { id: 'quality',  name: '代码质量',     description: '命名规范、注释完整度、代码风格、模块解耦、重复代码、单一职责原则等静态质量指标' },
  { id: 'bug',      name: '潜在 Bug',     description: '空指针/未定义访问、边界条件遗漏、异步竞态、资源泄露、异常处理缺失、状态管理不一致' },
  { id: 'perf',     name: '性能问题',     description: 'O(N²) 或更差的算法、不必要的深拷贝、同步阻塞调用、循环中重复计算、缺少缓存、数据库 N+1 查询' },
  { id: 'security', name: '安全风险',     description: '硬编码密钥、SQL 注入/XSS/CSRF、不安全的反序列化、路径遍历、输入校验缺失、依赖包已知漏洞' },
];

/**
 * Orchestrator 节点主函数
 * 返回 subtasks：4 个审查维度各一个 Worker 任务
 */
export async function orchestratorNode(state) {
  const repoPath = state.repoPath;
  console.log('\n🎯 Orchestrator: 分析仓库概况，生成审查计划...');

  const overview = getRepoOverview(repoPath);
  console.log(`  📋 仓库概况已提取（${overview.length} 字符）`);

  // 让 LLM 根据仓库特征，为每个维度生成"审查重点"
  const prompt = [
    new SystemMessage(`
你是代码审查项目的编排者。根据目标仓库的概况，为 4 个固定审查维度分别列出最值得关注的文件 / 模块 / 功能点。

输出 JSON 格式，不要其他文字：
\`\`\`json
{
  "quality":  ["重点文件或模块...", "重点文件或模块..."],
  "bug":      ["重点文件或模块...", "重点文件或模块..."],
  "perf":     ["重点文件或模块...", "重点文件或模块..."],
  "security": ["重点文件或模块...", "重点文件或模块..."]
}
\`\`\`

每个维度列 2-5 个重点即可，文件名尽量具体（如 src/utils/auth.js）。如果仓库是纯前端，security 可关注 XSS/CSRF；如果是后端 API，security 可关注鉴权/输入校验。
`),
    new HumanMessage(`【仓库概况】\n${overview}`),
  ];

  let focusMap = {};
  try {
    const resp = await llm.invoke(prompt);
    const content = resp.content.toString().trim();
    const jsonMatch = content.match(/```json\s*([\s\S]*?)```/) || content.match(/(\{[\s\S]*\})/);
    const parsed = JSON.parse(jsonMatch ? jsonMatch[1].trim() : content);
    focusMap = parsed;
    console.log('  ✅ 审查重点已生成');
  } catch (err) {
    console.log(`  ⚠️ LLM 解析失败，使用通用默认重点: ${err.message}`);
  }

  // 组装 subtasks（固定 4 维度）
  const subtasks = REVIEW_DIMENSIONS.map((dim) => ({
    id: `review-${dim.id}`,
    workerType: 'reviewer',
    dimension: dim.id,
    dimensionName: dim.name,
    description: dim.description,
    focusAreas: focusMap[dim.id] || [],
  }));

  console.log(`  📐 已生成 ${subtasks.length} 个审查任务（固定 4 维度）`);
  subtasks.forEach((t) => console.log(`    • ${t.dimensionName}: ${t.focusAreas.join(', ') || '通用全仓库'}`));

  return { subtasks };
}
