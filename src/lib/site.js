// Site-wide config. Most of this comes alive once the repo is public on GitHub.
export const site = {
  repo: 'ALPERKESKE/ask-in-order',
  branch: 'main',

  // giscus powers both discussion (comments) and ratings (GitHub reactions, 👍/👎).
  // Flip `enabled` to true after: (1) the repo is public, (2) GitHub Discussions
  // is on, (3) the giscus app is installed, then paste the IDs from https://giscus.app.
  giscus: {
    enabled: false,
    repoId: '',
    category: 'Paths',
    categoryId: '',
  },
};

// Deep link to GitHub's editor for a repo file — the "suggest a change" entry point.
// GitHub turns an edit by a non-collaborator into a fork + pull request automatically.
export function editUrl(filePath) {
  return `https://github.com/${site.repo}/edit/${site.branch}/${filePath}`;
}

export function newIssueUrl(title) {
  const q = title ? `?title=${encodeURIComponent(title)}` : '';
  return `https://github.com/${site.repo}/issues/new${q}`;
}
