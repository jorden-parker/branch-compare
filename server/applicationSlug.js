import { createHash } from 'node:crypto';

const longestReadableLength = 54;

export function buildApplicationSlug({ owner, repository, branch }) {
  const readablePart = `${repository}-${branch}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .slice(0, longestReadableLength)
    .replace(/^-+|-+$/g, '');
  const fingerprint = createHash('sha256')
    .update(`${owner}/${repository}`.toLowerCase())
    .update(`@${branch}`)
    .digest('hex')
    .slice(0, 8);
  return [readablePart, fingerprint].filter(Boolean).join('-');
}
