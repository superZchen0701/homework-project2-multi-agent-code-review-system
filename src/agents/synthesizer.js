/**
 * Synthesizer 节点（汇总报告生成）
 *
 * 职责：收集 4 个 Reviewer Worker 的审查结果，生成结构化 Markdown 报告
 *
 * 两层策略：
 *   1. 先用纯代码做基础汇总（统计问题数、按严重程度分组）
 *   2. 再让 LLM 润色报告正文（让总结更流畅、跨维度关联）
 *
 * 这样做的好处：即使 LLM 调用失败或解析失败，基础汇总也能交付
 */
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { llm } from '../config.js';

// ======================================================================
// 纯代码基础汇总（不依赖 LLM，保证最低可用报告）
// ======================================================================
function buildBasicReport(state) {
  const workerResults = state.worker_results || [];
  const repoName = state.repoName || 'unknown';
  const githubUrl = state.githubUrl || '';

  const now = new Date().toISOString().slice(0, 19).replace('T', ' ');

  // 统计汇总
  const allIssues = [];
  const dimensionScores = {};

  for (const w of workerResults) {
    const review = w.review || {};
    const dim = w.dimension || review.dimension;
    const dimName = w.dimensionName || review.dimensionName || dim;
    dimensionScores[dim] = review.score ?? 0;

    const issues = review.issues || [];
    for (const issue of issues) {
      allIssues.push({ ...issue, dimension: dim, dimensionName: dimName });
    }
  }

  // 按严重程度分组
  const critical = allIssues.filter((i) => i.severity === 'Critical');
  const major = allIssues.filter((i) => i.severity === 'Major');
  const minor = allIssues.filter((i) => i.severity === 'Minor');

  const avgScore =
    Object.values(dimensionScores).reduce((a, b) => a + b, 0) /
    (Object.values(dimensionScores).length || 1);

  // 构建 Markdown
  let md = '';

  md += `# 🔍 代码审查报告\n\n`;
  md += `> **仓库**: [${repoName}](${githubUrl})\n`;
  md += `> **审查时间**: ${now}\n`;
  md += `> **审查维度**: ${workerResults.length} 个（代码质量 / 潜在 Bug / 性能 / 安全）\n\n`;

  // 总览仪表盘
  md += `## 📊 总览\n\n`;
  md += `| 维度 | 评分 | 🔴 Critical | 🟡 Major | 🔵 Minor | 合计 |\n`;
  md += `|------|------|-------------|----------|----------|------|\n`;

  for (const w of workerResults) {
    const review = w.review || {};
    const issues = review.issues || [];
    const c = issues.filter((i) => i.severity === 'Critical').length;
    const m = issues.filter((i) => i.severity === 'Major').length;
    const n = issues.filter((i) => i.severity === 'Minor').length;
    const score = review.score ?? '-';
    md += `| ${w.dimensionName} | ${score}/10 | ${c} | ${m} | ${n} | ${issues.length} |\n`;
  }
  md += `| **总计** | **${avgScore.toFixed(1)}/10** | **${critical.length}** | **${major.length}** | **${minor.length}** | **${allIssues.length}** |\n\n`;

  // Critical 问题单独突出显示
  if (critical.length > 0) {
    md += `## 🚨 Critical 问题（必须修复）\n\n`;
    for (let i = 0; i < critical.length; i++) {
      const iss = critical[i];
      md += `### ${i + 1}. ${iss.type || '未分类'} — ${iss.file}:${iss.line || '?'}\n\n`;
      md += `- **问题**: ${iss.description || '无描述'}\n`;
      md += `- **建议**: ${iss.suggestion || '暂无可自动建议'}\n\n`;
    }
  }

  // 按维度分详情
  md += `## 📝 详细审查结果\n\n`;
  for (const w of workerResults) {
    const review = w.review || {};
    const dimName = w.dimensionName;
    const iconMap = { quality: '✨', bug: '🐛', perf: '⚡', security: '🔒' };
    const icon = iconMap[w.dimension] || '📌';

    md += `### ${icon} ${dimName}\n\n`;
    md += `**评分**: ${review.score ?? '-'}/10  \n\n`;
    md += `**总结**: ${review.summary || '无总结'}\n\n`;

    const issues = review.issues || [];
    if (issues.length === 0) {
      md += `✅ 本维度未发现明显问题。\n\n`;
    } else {
      md += `| # | 严重度 | 文件:行号 | 类型 | 问题描述 |\n`;
      md += `|---|--------|-----------|------|----------|\n`;
      for (let i = 0; i < issues.length; i++) {
        const iss = issues[i];
        const sevIcon = iss.severity === 'Critical' ? '🔴' : iss.severity === 'Major' ? '🟡' : '🔵';
        md += `| ${i + 1} | ${sevIcon} ${iss.severity || '-'} | ${iss.file || '-'}:${iss.line || '-'} | ${iss.type || '-'} | ${(iss.description || '').replace(/\n/g, ' ').slice(0, 80)} |\n`;
      }
      md += `\n<details><summary>查看完整修复建议</summary>\n\n`;
      for (let i = 0; i < issues.length; i++) {
        const iss = issues[i];
        md += `**${i + 1}. ${iss.file || '-'}:${iss.line || '?'} — ${iss.type || '-'}**\n\n`;
        md += `- 🔍 **问题**: ${iss.description || '无'}\n`;
        md += `- 💡 **建议**: ${iss.suggestion || '无'}\n\n`;
      }
      md += `</details>\n\n`;
    }

    const goods = review.goodPractices || [];
    if (goods.length > 0) {
      md += `**值得肯定**:\n`;
      for (const g of goods) md += `- ✅ ${g}\n`;
      md += `\n`;
    }
  }

  // 优先建议
  md += `## 🎯 优先修复建议\n\n`;
  const topIssues = [...critical, ...major].slice(0, 5);
  if (topIssues.length > 0) {
    for (let i = 0; i < topIssues.length; i++) {
      const iss = topIssues[i];
      md += `${i + 1}. **[${iss.dimensionName}]** ${iss.file || '-'}:${iss.line || '?'} — ${iss.description || ''} → ${iss.suggestion || ''}\n`;
    }
  } else {
    md += `🎉 未发现 Critical 或 Major 级问题，代码质量良好！\n`;
  }
  md += `\n`;

  // 附录
  md += `---\n\n`;
  md += `> 本报告由 Multi-Agent Code Review System 自动生成（LangGraph + CodeRAG + 4 维度并行审查）\n`;

  return {
    markdown: md,
    summary: {
      repoName,
      githubUrl,
      avgScore: avgScore.toFixed(1),
      totalIssues: allIssues.length,
      criticalCount: critical.length,
      majorCount: major.length,
      minorCount: minor.length,
      dimensions: Object.keys(dimensionScores),
    },
  };
}

// ======================================================================
// Synthesizer 主函数
// ======================================================================
export async function synthesizerNode(state) {
  console.log('\n📦 Synthesizer: 汇总所有审查结果，生成报告...');
  const workerResults = state.worker_results || [];

  if (workerResults.length === 0) {
    console.log('  ⚠️ 没有 Worker 产出，生成空报告');
    return { markdown: '# 审查失败\n\n未获得任何审查结果。', reviewSummary: {} };
  }

  // Step 1：纯代码基础汇总（保底）
  const basic = buildBasicReport(state);
  console.log(`  📝 基础汇总完成：${basic.summary.totalIssues} 个问题`);

  // Step 2：LLM 润色（可选，失败不影响交付）
  try {
    const workerJson = workerResults.map((w) => ({
      dimension: w.dimension,
      dimensionName: w.dimensionName,
      score: w.review?.score ?? 0,
      summary: w.review?.summary || '',
      issueCount: w.review?.issues?.length || 0,
    }));

    const resp = await llm.invoke([
      new SystemMessage(
        `你是代码审查报告的首席编辑。请根据下面的 4 维度审查统计，输出一段**精炼的执行摘要**（3-5 句话），作为报告开头的"Executive Summary"。

要求：
- 先给一个整体印象（正面 or 负面）
- 指出最严重的 1-2 个问题类型
- 给出最核心的 1 条改进建议
- 不要复述数字表格（那些已经在报告里了）`
      ),
      new HumanMessage(
        `仓库：${state.repoName}\nGitHub: ${state.githubUrl}\n\n审查统计：\n${JSON.stringify(workerJson, null, 2)}`
      ),
    ]);

    const executiveSummary = resp.content.toString().trim();

    // 将执行摘要插入到基础报告的合适位置
    const marker = '## 📊 总览';
    const mdWithSummary = basic.markdown.replace(
      marker,
      `## 🎯 执行摘要\n\n${executiveSummary}\n\n${marker}`
    );

    console.log('  ✅ LLM 执行摘要已生成');
    return { markdown: mdWithSummary, reviewSummary: basic.summary };
  } catch (err) {
    console.log(`  ⚠️ LLM 润色失败，使用基础报告: ${err.message}`);
    return { markdown: basic.markdown, reviewSummary: basic.summary };
  }
}
