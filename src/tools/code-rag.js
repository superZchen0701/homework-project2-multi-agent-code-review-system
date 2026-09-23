/**
 * 代码仓库级 RAG 引擎
 *
 * 核心流程：
 *   AST 解析 → 函数/类级分片 → Embedding → 内存向量索引 → search() 检索
 *
 * 设计要点：
 * - 单例复用：索引只构建一次，多个 Worker 共享同一个 CodeRAG 实例
 * - AST 优先：优先用 @babel/parser 提取函数/类级代码块，语义边界清晰
 * - 回退策略：AST 解析失败的文件按行切块，保证不丢内容
 * - 安全限制：最多索引 MAX_FILES 个代码文件，防止超大全仓库 embedding 爆配额
 */
import { parse as babelParse } from '@babel/parser';
import fs from 'fs';
import path from 'path';
import { embedTexts, embedText, cosineSimilarity } from '../config.js';

// ======================================================================
// 常量
// ======================================================================
const CODE_EXTS = [
  '.js', '.mjs', '.cjs', '.jsx',
  '.ts', '.mts', '.cts', '.tsx',
  '.py', '.go', '.rs', '.java', '.kt',
];

// 跳过目录（避免把 node_modules / .git 里的垃圾喂给 Embedding API）
const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build',
  '.next', '.nuxt', 'coverage', 'vendor',
]);

// 单仓库最多索引的代码文件数（超大全仓库降级）
const MAX_FILES_PER_REPO = 200;

// ======================================================================
// 工具函数
// ======================================================================

/**
 * 递归收集仓库内所有代码文件（过滤 SKIP_DIRS）
 */
function collectCodeFiles(rootDir) {
  const results = [];
  const walk = (dir) => {
    if (results.length >= MAX_FILES_PER_REPO) return;

    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // 无权限等
    }

    for (const entry of entries) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (CODE_EXTS.includes(path.extname(entry.name).toLowerCase())) {
        results.push(full);
      }
    }
  };
  walk(rootDir);
  return results;
}

/**
 * AST 分片：用 @babel/parser 把源码切成函数/类级代码块
 * 仅支持 JS/TS 系；其他语言返回空数组（由调用方回退）
 * @returns {Array<{name:string, code:string, startLine:number}>}
 */
function astChunk(source) {
  const chunks = [];
  let ast;
  try {
    ast = babelParse(source, {
      sourceType: 'unambiguous',
      plugins: ['jsx', 'typescript', 'classProperties'],
      errorRecovery: true,
    });
  } catch {
    return chunks; // 解析失败 → 交给行级回退
  }

  for (const node of ast.program.body) {
    // 顶层函数声明：function foo() {}
    if (node.type === 'FunctionDeclaration') {
      chunks.push({
        name: node.id?.name || '(anonymous)',
        code: source.slice(node.start, node.end),
        startLine: node.loc.start.line,
      });
    }
    // 变量声明中赋值为箭头函数 / 函数表达式：const foo = () => {}
    else if (node.type === 'VariableDeclaration') {
      for (const decl of node.declarations) {
        const fn = decl.init;
        if (fn && (fn.type === 'ArrowFunctionExpression' || fn.type === 'FunctionExpression')) {
          chunks.push({
            name: decl.id?.name || '(anonymous)',
            code: source.slice(node.start, node.end),
            startLine: node.loc.start.line,
          });
        }
      }
    }
    // 类声明：class Foo { ... }  → 整体 + 方法级
    else if (node.type === 'ClassDeclaration') {
      const className = node.id?.name || '(anonymous)';
      chunks.push({
        name: `class ${className}`,
        code: source.slice(node.start, node.end),
        startLine: node.loc.start.line,
      });
      for (const member of node.body.body) {
        if ((member.type === 'ClassMethod' || member.type === 'ClassProperty') && member.key?.name) {
          chunks.push({
            name: `${className}#${member.key.name}`,
            code: source.slice(member.start, member.end),
            startLine: member.loc.start.line,
          });
        }
      }
    }
  }
  return chunks;
}

/**
 * 解析单个文件 → 代码片段列表
 * AST 成功 → 函数/类级；失败 → 按行切块
 */
function chunkFile(filePath, rootDir) {
  const relative = path.relative(rootDir, filePath);
  const source = fs.readFileSync(filePath, 'utf-8');

  // AST 分片（仅 JS/TS 系）
  const ext = path.extname(filePath).toLowerCase();
  const jsTsExts = ['.js', '.mjs', '.cjs', '.jsx', '.ts', '.mts', '.cts', '.tsx'];
  if (jsTsExts.includes(ext)) {
    const astChunks = astChunk(source);
    if (astChunks.length > 0) {
      return astChunks.map((c) => ({
        name: c.name,
        path: relative,
        startLine: c.startLine,
        content: c.code,
        kind: 'ast',
      }));
    }
  }

  // 回退：按行切块（60 行 / 块，10 行重叠）
  const lines = source.split('\n');
  const chunks = [];
  const chunkSize = 60, overlap = 10;
  for (let i = 0; i < lines.length; i += chunkSize - overlap) {
    const seg = lines.slice(i, i + chunkSize).join('\n');
    if (seg.trim()) {
      chunks.push({
        name: `file#L${i + 1}`,
        path: relative,
        startLine: i + 1,
        content: seg,
        kind: 'fallback',
      });
    }
  }
  return chunks;
}

// ======================================================================
// CodeRAG 引擎
// ======================================================================
export class CodeRAG {
  constructor(rootDir) {
    this.rootDir = rootDir;
    /** 向量库：[{ name, path, startLine, content, kind, vector }] */
    this.store = [];
    this.built = false;
  }

  /**
   * 构建索引（一次性，耗时的 Embedding 调用集中在这里）
   * 结果缓存在 this.store，后续 Worker 直接复用
   */
  async buildIndex() {
    if (this.built) {
      console.log('  ⚠️ 索引已构建，跳过重复 buildIndex');
      return this;
    }

    console.log('\n🧬 [CodeRAG] 扫描代码文件...');
    const files = collectCodeFiles(this.rootDir);
    console.log(`  发现 ${files.length} 个代码文件（上限 ${MAX_FILES_PER_REPO}）`);

    console.log('🧬 [CodeRAG] AST 分片...');
    const allChunks = [];
    for (const f of files) {
      const fileChunks = chunkFile(f, this.rootDir);
      allChunks.push(...fileChunks);
      // 日志：文件名 + 片段数（简洁）
      console.log(`    ${path.relative(this.rootDir, f)} → ${fileChunks.length} 片段`);
    }
    console.log(`  共 ${allChunks.length} 个代码片段，开始向量化...`);

    // 空仓库保护：没有任何代码文件就不调 Embedding API
    if (allChunks.length === 0) {
      console.log('  ⚠️ 仓库内未发现可索引的代码片段，跳过向量化');
      this.store = [];
      this.built = true;
      return this;
    }

    // Embedding 分批调用（智谱单次上限 16 条）
    const contents = allChunks.map((c) => c.content);
    const vectors = await embedTexts(contents);

    this.store = allChunks.map((c, i) => ({ ...c, vector: vectors[i] }));
    this.built = true;
    console.log(`  ✅ 索引构建完成：${this.store.length} 条代码片段`);

    return this;
  }

  /**
   * 语义检索：query → Top-K 最相似的代码片段
   */
  async search(query, topK = 5) {
    if (!this.built) throw new Error('索引未构建，请先调用 buildIndex()');
    const qv = await embedText(query);
    return this.store
      .map((item) => ({ ...item, score: cosineSimilarity(qv, item.vector) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }
}

/**
 * 把 CodeRAG.search() 包装成给 Agent 用的工具函数
 * 返回格式化字符串，直接塞给 LLM 上下文
 */
export async function formatSearchResults(rag, query, topK = 5) {
  const results = await rag.search(query, topK);
  return results
    .map(
      (r, i) =>
        `【片段 ${i + 1}】${r.path}:${r.startLine} | 相似度=${r.score.toFixed(4)} | ${r.name}\n` +
        '```\n' + r.content + '\n```'
    )
    .join('\n\n---\n\n');
}
