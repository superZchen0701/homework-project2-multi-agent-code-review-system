/**
 * 入口：Multi-Agent Code Review System
 *
 * 用法：
 *   node src/index.js <github-url>
 *   pnpm start <github-url>
 *
 * 示例：
 *   node src/index.js https://github.com/superZchen0701/homework-project1-personal-agent.git
 *
 * 流程：
 *   GitHub URL → clone → CodeRAG 索引构建 → 4 维度并行审查 → 汇总 Markdown 报告
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createReviewApp } from './graph.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');
const REPORTS_DIR = path.join(PROJECT_ROOT, 'reports');

// ======================================================================
// 命令行参数解析
// ======================================================================
function parseArgs() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.error('用法: node src/index.js <github-url>');
    console.error('示例: node src/index.js https://github.com/owner/repo.git');
    process.exit(1);
  }
  return { githubUrl: args[0] };
}

// ======================================================================
// 报告落盘
// ======================================================================
function saveReport(repoName, markdown) {
  fs.mkdirSync(REPORTS_DIR, { recursive: true });
  const timestamp = new Date().toISOString().slice(0, 10);
  const filename = `${timestamp}-${repoName}-review.md`;
  const filePath = path.join(REPORTS_DIR, filename);
  fs.writeFileSync(filePath, markdown, 'utf-8');
  return filePath;
}

// ======================================================================
// 主流程
// ======================================================================
async function main() {
  const { githubUrl } = parseArgs();

  console.log('═'.repeat(70));
  console.log('Multi-Agent Code Review System');
  console.log('   LangGraph Pipeline + CodeRAG + 4 维度并行审查');
  console.log('═'.repeat(70));
  console.log(`\n🎯 目标仓库: ${githubUrl}`);

  // 构建并执行工作流
  const app = createReviewApp();
  const result = await app.invoke({ githubUrl });

  // 输出结果概览
  console.log('\n' + '═'.repeat(70));
  console.log('🎉 审查完成！');
  console.log('═'.repeat(70));

  const summary = result.reviewSummary || {};
  console.log(`\n📊 审查汇总:`);
  console.log(`   仓库: ${summary.repoName || result.repoName}`);
  console.log(`   总体评分: ${summary.avgScore || '-'}/10`);
  console.log(`   问题总数: ${summary.totalIssues || 0}`);
  console.log(`   🔴 Critical: ${summary.criticalCount || 0}`);
  console.log(`   🟡 Major: ${summary.majorCount || 0}`);
  console.log(`   🔵 Minor: ${summary.minorCount || 0}`);

  // 报告落盘
  const markdown = result.markdown || '# 审查失败\n\n无报告生成。';
  const filePath = saveReport(result.repoName || 'unknown', markdown);
  console.log(`\n📄 报告已保存: ${path.relative(PROJECT_ROOT, filePath)}`);

  // 在终端也输出 Markdown（截取前 3000 字符预览）
  console.log('\n' + '─'.repeat(70));
  console.log('📝 报告预览:');
  console.log('─'.repeat(70));
  console.log(markdown.slice(0, 3000) + (markdown.length > 3000 ? '\n\n...(已截断，完整内容见报告文件)' : ''));

  console.log('\n✅ 全部完成');
}

main().catch((err) => {
  console.error('\n❌ 执行失败:', err);
  console.error(err.stack);
  process.exit(1);
});
