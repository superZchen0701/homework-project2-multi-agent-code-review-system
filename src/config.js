/**
 * 模型与环境配置
 *
 * 统一管理 LLM / Embedding 模型初始化，避免各模块重复 new。
 * - LLM：DeepSeek（用于 Agent 推理 / 审查 / 报告生成）
 * - Embedding：智谱 BigModel（用于代码向量化）
 */
import { ChatOpenAI } from '@langchain/openai';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

// 加载根目录 .env
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../.env') });

// ======================================================================
// 环境变量校验
// ======================================================================
function requireEnv(name, hint) {
  const val = process.env[name];
  if (!val) throw new Error(`缺少环境变量 ${name}，${hint || ''}`);
  return val;
}

// ======================================================================
// LLM：DeepSeek Chat
// ======================================================================
const llm = new ChatOpenAI({
  apiKey: requireEnv('DEEPSEEK_API_KEY', '请在 .env 中配置 DEEPSEEK_API_KEY'),
  modelName: process.env.DEEPSEEK_MODEL || 'deepseek-chat',
  temperature: 0,
  configuration: {
    baseURL: process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com',
  },
  timeout: 120_000,
  maxRetries: 2,
});

// ======================================================================
// Embedding：智谱 BigModel embedding-3（纯 API 调用，不依赖 langchain-community）
// ======================================================================
const BIGMODEL_EMBEDDING_API_URL = requireEnv(
  'BIGMODEL_EMBEDDING_API_URL',
  '请在 .env 中配置 BIGMODEL_EMBEDDING_API_URL'
);
const BIGMODEL_EMBEDDING_API_KEY = requireEnv(
  'BIGMODEL_EMBEDDING_API_KEY',
  '请在 .env 中配置 BIGMODEL_EMBEDDING_API_KEY'
);

/**
 * 批量文本向量化（智谱 embedding-3）
 * 单次请求上限 16 条，超过自动分批
 * @param {string[]} texts
 * @returns {Promise<number[][]>} 向量数组，与 texts 一一对应
 */
async function embedTexts(texts) {
  const batchSize = 16;
  const allVectors = [];

  for (let i = 0; i < texts.length; i += batchSize) {
    const batch = texts.slice(i, i + batchSize);
    const res = await fetch(BIGMODEL_EMBEDDING_API_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${BIGMODEL_EMBEDDING_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ input: batch, model: 'embedding-3', encoding_format: 'float' }),
    });

    if (!res.ok) {
      throw new Error(`Embedding API 失败: HTTP ${res.status} - ${await res.text()}`);
    }
    const data = await res.json();
    const vectors = data.data
      .sort((a, b) => a.index - b.index)
      .map((item) => item.embedding);
    allVectors.push(...vectors);
  }
  return allVectors;
}

/** 单条文本向量化 */
async function embedText(text) {
  const [vec] = await embedTexts([text]);
  return vec;
}

/** 余弦相似度 */
function cosineSimilarity(a, b) {
  if (a.length !== b.length) {
    throw new Error('向量维度不一致，请确认建库和查询使用同一嵌入模型');
  }
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export { llm, embedTexts, embedText, cosineSimilarity };
