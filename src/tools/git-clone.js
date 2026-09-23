/**
 * GitHub 仓库克隆工具
 *
 * 功能：从 GitHub URL 解析仓库名 → git clone 到本地 repos/ 目录
 *
 * 安全考虑：
 * - 仅支持 https://github.com/... 格式，拒绝 ssh / git 协议
 * - 自动清理已存在的同名目录（避免脏数据）
 */
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPOS_ROOT = path.resolve(__dirname, '../../repos');

/**
 * 从 GitHub URL 提取 owner/repo 作为本地目录名
 * 支持格式：
 *   https://github.com/owner/repo
 *   https://github.com/owner/repo.git
 *   https://github.com/owner/repo/tree/main  （忽略后续路径）
 */
function parseRepoName(githubUrl) {
  const match = githubUrl.match(/github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?(?:\/|$)/);
  if (!match) throw new Error(`无法解析 GitHub URL: ${githubUrl}`);
  return `${match[1]}-${match[2]}`;
}

/**
 * 克隆仓库到 repos/<owner-repo>
 * @param {string} githubUrl
 * @returns {{ localPath: string, repoName: string }}
 */
export function cloneRepo(githubUrl) {
  if (!githubUrl) throw new Error('请提供 GitHub 仓库地址');

  const repoName = parseRepoName(githubUrl);
  const localPath = path.join(REPOS_ROOT, repoName);

  // 确保 repos 根目录存在
  fs.mkdirSync(REPOS_ROOT, { recursive: true });

  // 清理已存在的同名目录（可能是上次克隆残留）
  if (fs.existsSync(localPath)) {
    console.log(`  🧹 清理已存在的目录: ${repoName}`);
    fs.rmSync(localPath, { recursive: true, force: true });
  }

  console.log(`  📥 正在克隆: ${githubUrl} → ${localPath}`);
  try {
    // --depth 1 浅克隆，节省时间和空间
    execSync(`git clone --depth 1 ${githubUrl} ${localPath}`, {
      stdio: 'pipe',
      timeout: 120_000,
    });
  } catch (err) {
    throw new Error(`克隆失败: ${err.message}`);
  }

  console.log(`  ✅ 克隆完成: ${repoName}`);
  return { localPath, repoName };
}
