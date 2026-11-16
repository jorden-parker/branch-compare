import test from 'node:test';
import assert from 'node:assert/strict';
import { PNG } from 'pngjs';
import { compareImages } from '../server/visualComparison.js';

function createWhiteImage(width, height) {
  const image = new PNG({ width, height });
  image.data.fill(255);
  return image;
}

function paintPixelBlack(image, column, row) {
  const offset = (row * image.width + column) * 4;
  image.data[offset] = 0;
  image.data[offset + 1] = 0;
  image.data[offset + 2] = 0;
}

test('reports no mismatched pixels for identical images', () => {
  const imageBuffer = PNG.sync.write(createWhiteImage(8, 8));

  const comparison = compareImages(imageBuffer, imageBuffer);

  assert.equal(comparison.mismatchedPixelCount, 0);
  assert.equal(comparison.totalPixelCount, 64);
});

test('counts each pixel that differs and returns a difference image', () => {
  const candidate = createWhiteImage(8, 8);
  paintPixelBlack(candidate, 3, 3);

  const comparison = compareImages(PNG.sync.write(createWhiteImage(8, 8)), PNG.sync.write(candidate));

  assert.equal(comparison.mismatchedPixelCount, 1);
  assert.equal(PNG.sync.read(comparison.differenceImage).width, 8);
});

test('counts the extra area as different when one page is taller', () => {
  const comparison = compareImages(PNG.sync.write(createWhiteImage(8, 8)), PNG.sync.write(createWhiteImage(8, 12)));

  assert.equal(comparison.totalPixelCount, 96);
  assert.equal(comparison.mismatchedPixelCount, 32);
});
