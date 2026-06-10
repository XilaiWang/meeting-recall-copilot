import { isAllowed, truncate } from './common.js';

interface GhFile { path: string; type: string; size?: number; }
interface GhCommit { commit: { message: string } }

export interface ParseOptions {
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
}

// Why: GitHub API unauthenticated rate limit is 60 req/h.
// We use at most 4 requests (info + README + tree + up to 10 files)
// and never exceed this for typical repos.
export async function parseGithubUrl(url: string, opts: ParseOptions = {}): Promise<string> {
  const { signal, onProgress } = opts;
  const match = url.match(/github\.com\/([^/]+)\/([^/#?]+)/);
  if (!match?.[1] || !match?.[2]) {
    // Check if it's a user/org profile URL (e.g. github.com/XilaiWang)
    const profileMatch = url.match(/github\.com\/([^/]+)\/?$/);
    if (profileMatch?.[1]) {
      throw new Error(
        `这是 GitHub 个人主页，请输入具体的仓库地址，例如：github.com/${profileMatch[1]}/项目名称`,
      );
    }
    throw new Error('无效的 GitHub URL，格式：github.com/用户名/仓库名');
  }
  const [, owner, repo] = match;
  const base = `https://api.github.com/repos/${owner}/${repo}`;
  const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'qa-matching-app' };

  onProgress?.('正在获取仓库信息…');
  const check = await fetch(base, { headers, signal });
  if (!check.ok) {
    if (check.status === 404) throw new Error('仓库不存在或为私有');
    if (check.status === 403) throw new Error('GitHub API 限流，请稍后重试');
    throw new Error(`GitHub API 错误 ${check.status}`);
  }
  const info = await check.json() as { description?: string; language?: string };

  const parts: string[] = [`# ${owner}/${repo}`, info.description ?? '', `主要语言: ${info.language ?? '未知'}`, ''];

  // README
  onProgress?.('正在读取 README…');
  const readmeRes = await fetch(`${base}/readme`, { headers, signal });
  if (readmeRes.ok) {
    const rm = await readmeRes.json() as { content?: string };
    if (rm.content) {
      parts.push('## README', Buffer.from(rm.content.replace(/\n/g, ''), 'base64').toString('utf8'), '');
    }
  }

  // Last 30 commit messages
  onProgress?.('正在读取提交记录…');
  const commitsRes = await fetch(`${base}/commits?per_page=30`, { headers, signal });
  if (commitsRes.ok) {
    const commits = await commitsRes.json() as GhCommit[];
    parts.push('## 最近提交记录');
    for (const c of commits) parts.push(`- ${c.commit.message.split('\n')[0]}`);
    parts.push('');
  }

  // File tree — fetch content of top allowed files (≤ 10, each ≤ 50 kB)
  const treeRes = await fetch(`${base}/git/trees/HEAD?recursive=1`, { headers, signal });
  if (treeRes.ok) {
    const tree = await treeRes.json() as { tree: GhFile[]; truncated?: boolean };
    if (tree.truncated) {
      // Why: GitHub truncates trees >100k files or >7MB; flag it instead of silently losing data.
      parts.push('> 注意：仓库文件数超限，代码文件列表已截断。', '');
    }
    const files = tree.tree
      .filter((f) => f.type === 'blob' && isAllowed(f.path) && (f.size ?? 0) < 50_000)
      .slice(0, 10);
    if (files.length) {
      parts.push('## 代码文件');
      for (let i = 0; i < files.length; i++) {
        const f = files[i]!;
        onProgress?.(`正在读取代码文件 ${i + 1}/${files.length}：${f.path}`);
        const fr = await fetch(`${base}/contents/${f.path}`, { headers, signal });
        if (!fr.ok) continue;
        const fc = await fr.json() as { content?: string };
        if (!fc.content) continue;
        const content = Buffer.from(fc.content.replace(/\n/g, ''), 'base64').toString('utf8');
        parts.push(`### ${f.path}`, '```', content.slice(0, 8000), '```', '');
      }
    }
  }

  return truncate(parts.join('\n'));
}
