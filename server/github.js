const pageSize = 100;
const pageLimit = 5;

export class GithubError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function explainRefusal(response, githubMessage, hasToken) {
  if (response.status === 401) {
    return hasToken
      ? 'GitHub rejected the token (401 Bad credentials). Enter a valid GitHub token.'
      : 'GitHub needs a token for this request. Add a GitHub token.';
  }
  if (response.headers.get('x-ratelimit-remaining') === '0') {
    return hasToken
      ? 'GitHub rate limit reached for this token. Try again later.'
      : 'GitHub rate limit reached for requests without a token. Add a GitHub token to raise the limit.';
  }
  return `GitHub answered ${response.status}: ${githubMessage}`;
}

export function createGithubClient({ apiUrl = 'https://api.github.com', readToken }) {
  async function requestGithub(requestPath, token = readToken()) {
    const headers = { accept: 'application/vnd.github+json' };
    if (token) headers.authorization = `Bearer ${token}`;
    let response;
    try {
      response = await fetch(apiUrl + requestPath, { headers });
    } catch {
      throw new GithubError(502, 'Could not reach GitHub. Check the network connection.');
    }
    if (response.ok) return response.json();
    const refusal = await response.json().catch(() => ({}));
    throw new GithubError(
      response.status,
      explainRefusal(response, refusal.message ?? response.statusText, Boolean(token)),
    );
  }

  async function fetchPages(requestPath) {
    const entries = [];
    const separator = requestPath.includes('?') ? '&' : '?';
    for (let pageNumber = 1; pageNumber <= pageLimit; pageNumber += 1) {
      const pageEntries = await requestGithub(`${requestPath}${separator}per_page=${pageSize}&page=${pageNumber}`);
      entries.push(...pageEntries);
      if (pageEntries.length < pageSize) return { entries, isTruncated: false };
    }
    return { entries, isTruncated: true };
  }

  async function fetchPagesUnlessMissing(requestPath) {
    try {
      return await fetchPages(requestPath);
    } catch (error) {
      if (error.status === 404) return null;
      throw error;
    }
  }

  async function fetchLogin(token = readToken()) {
    if (!token) return null;
    const user = await requestGithub('/user', token);
    return user.login;
  }

  async function listOwners() {
    const login = await fetchLogin();
    if (!login) return [];
    const organisations = await fetchPages('/user/orgs').catch(() => ({ entries: [] }));
    return [login, ...organisations.entries.map((organisation) => organisation.login)];
  }

  async function fetchRepositoryPages(owner, login) {
    if (login && login.toLowerCase() === owner.toLowerCase()) {
      return fetchPages('/user/repos?affiliation=owner&sort=pushed');
    }
    const ownerSegment = encodeURIComponent(owner);
    const repositoryPages =
      (await fetchPagesUnlessMissing(`/orgs/${ownerSegment}/repos?sort=pushed`)) ??
      (await fetchPagesUnlessMissing(`/users/${ownerSegment}/repos?sort=pushed`));
    if (repositoryPages) return repositoryPages;
    throw new GithubError(404, `No organisation or user named "${owner}" is visible${login ? ' to this token' : ''}.`);
  }

  async function listRepositories(owner) {
    const login = await fetchLogin();
    const { entries, isTruncated } = await fetchRepositoryPages(owner, login);
    return {
      repositories: entries.map((entry) => ({
        name: entry.name,
        isPrivate: entry.private,
        defaultBranch: entry.default_branch,
      })),
      isTruncated,
      isAuthenticated: login !== null,
    };
  }

  async function listBranches(owner, repository) {
    const branchPages = await fetchPagesUnlessMissing(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/branches`,
    );
    if (!branchPages) {
      throw new GithubError(404, `GitHub cannot find ${owner}/${repository}, or the token cannot read it.`);
    }
    return { branches: branchPages.entries.map((entry) => entry.name), isTruncated: branchPages.isTruncated };
  }

  return { fetchLogin, listOwners, listRepositories, listBranches };
}
