import test from 'node:test';
import assert from 'node:assert/strict';
import { buildApplicationSlug } from '../server/applicationSlug.js';

test('builds a hostname label from the repository and branch', () => {
  const slug = buildApplicationSlug({ owner: 'Acme', repository: 'Web.Shop', branch: 'feature/New_Header' });

  assert.match(slug, /^web-shop-feature-new-header-[0-9a-f]{8}$/);
});

test('keeps long branch names inside the 63 character hostname label limit', () => {
  const slug = buildApplicationSlug({ owner: 'acme', repository: 'shop', branch: 'feature/'.padEnd(200, 'x') });

  assert.ok(slug.length <= 63);
  assert.match(slug, /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/);
});

test('gives main and another branch of one repository different slugs', () => {
  const mainSlug = buildApplicationSlug({ owner: 'acme', repository: 'shop', branch: 'main' });
  const branchSlug = buildApplicationSlug({ owner: 'acme', repository: 'shop', branch: 'checkout' });

  assert.notEqual(mainSlug, branchSlug);
});

test('separates branches whose names sanitise to the same text', () => {
  const slashSlug = buildApplicationSlug({ owner: 'acme', repository: 'shop', branch: 'fix/cart' });
  const hyphenSlug = buildApplicationSlug({ owner: 'acme', repository: 'shop', branch: 'fix-cart' });

  assert.notEqual(slashSlug, hyphenSlug);
});
