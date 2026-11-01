import { readFileSync } from 'node:fs';
import { MARKER } from './report.js';

export interface PrContext {
  owner: string;
  repo: string;
  number: number;
  apiUrl: string;
}

/** PR details from the GitHub Actions environment, or undefined outside a PR. */
export function prContext(env: NodeJS.ProcessEnv = process.env): PrContext | undefined {
  const [owner, repo] = (env.GITHUB_REPOSITORY ?? '').split('/');
  if (!owner || !repo || !env.GITHUB_EVENT_PATH) return undefined;
  const event = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, 'utf8')) as { pull_request?: { number?: number } };
  const number = event.pull_request?.number;
  if (typeof number !== 'number') return undefined;
  return { owner, repo, number, apiUrl: env.GITHUB_API_URL ?? 'https://api.github.com' };
}

async function gh(token: string, url: string, init: RequestInit = {}): Promise<Response> {
  const res = await fetch(url, {
    ...init,
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
      'x-github-api-version': '2022-11-28',
      'content-type': 'application/json',
    },
  });
  if (!res.ok) throw new Error(`GitHub API ${init.method ?? 'GET'} ${new URL(url).pathname} failed: ${res.status}`);
  return res;
}

/** Create our PR comment, or update it if we posted one before. */
export async function upsertComment(token: string, pr: PrContext, body: string): Promise<'created' | 'updated'> {
  const base = `${pr.apiUrl}/repos/${pr.owner}/${pr.repo}`;
  for (let page = 1; page <= 10; page++) {
    const res = await gh(token, `${base}/issues/${pr.number}/comments?per_page=100&page=${page}`);
    const comments = (await res.json()) as Array<{ id: number; body?: string }>;
    const ours = comments.find((c) => c.body?.includes(MARKER));
    if (ours) {
      await gh(token, `${base}/issues/comments/${ours.id}`, { method: 'PATCH', body: JSON.stringify({ body }) });
      return 'updated';
    }
    if (comments.length < 100) break;
  }
  await gh(token, `${base}/issues/${pr.number}/comments`, { method: 'POST', body: JSON.stringify({ body }) });
  return 'created';
}
