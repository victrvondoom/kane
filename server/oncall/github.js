// Minimal GitHub REST client for the two things the agent may do there: open a pull request, and (with approval) merge one.
export function createGithub({ token, api = 'https://api.github.com', fetchImpl = fetch }) {
  const call = async (method, url, body) => {
    if (!token) throw Object.assign(new Error('GitHub is not configured: set ONCALL_GITHUB_TOKEN on the server'), { code: 'github_not_configured' });
    let res;
    try { res = await fetchImpl(api + url, { method, headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'shipproof-oncall', ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30000) }); }
    catch (e) { throw Object.assign(new Error(`GitHub is unreachable: ${e.message}`), { code: 'github_unreachable' }); }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(`GitHub ${method} ${url} → ${res.status}: ${data.message || 'request failed'}${data.errors ? ' — ' + data.errors.map((e) => e.message || e.code).join('; ') : ''}`), { status: res.status, code: 'github_error' });
    return data;
  };
  return {
    configured: !!token,
    async openPullRequest({ repo, head, base, title, body, draft = true }) {
      const existing = await call('GET', `/repos/${repo}/pulls?state=open&head=${encodeURIComponent(repo.split('/')[0] + ':' + head)}`);
      if (Array.isArray(existing) && existing[0]) return { number: existing[0].number, url: existing[0].html_url, existing: true, draft: !!existing[0].draft };
      const pr = await call('POST', `/repos/${repo}/pulls`, { title, head, base, body, draft });
      return { number: pr.number, url: pr.html_url, existing: false, draft: !!pr.draft };
    },
    getPullRequest: ({ repo, number }) => call('GET', `/repos/${repo}/pulls/${number}`),
    async mergePullRequest({ repo, number, sha }) {
      const r = await call('PUT', `/repos/${repo}/pulls/${number}/merge`, { merge_method: 'merge', ...(sha ? { sha } : {}) });
      return { merged: !!r.merged, sha: r.sha, message: r.message };
    },
  };
}
