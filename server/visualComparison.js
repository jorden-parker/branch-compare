import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';
import { chromium } from 'playwright-core';

const viewport = { width: 1280, height: 800 };
const settleTimeoutMilliseconds = 5000;
const opaqueMagenta = 0xff00ffff;

function padImage(image, width, height) {
  if (image.width === width && image.height === height) return image;
  const paddedImage = new PNG({ width, height });
  for (let offset = 0; offset < paddedImage.data.length; offset += 4) {
    paddedImage.data.writeUInt32BE(opaqueMagenta, offset);
  }
  PNG.bitblt(image, paddedImage, 0, 0, image.width, image.height, 0, 0);
  return paddedImage;
}

export function compareImages(baselineImage, candidateImage) {
  const baseline = PNG.sync.read(baselineImage);
  const candidate = PNG.sync.read(candidateImage);
  const width = Math.max(baseline.width, candidate.width);
  const height = Math.max(baseline.height, candidate.height);
  const difference = new PNG({ width, height });
  const mismatchedPixelCount = pixelmatch(
    padImage(baseline, width, height).data,
    padImage(candidate, width, height).data,
    difference.data,
    width,
    height,
    { threshold: 0.1 },
  );
  return { differenceImage: PNG.sync.write(difference), mismatchedPixelCount, totalPixelCount: width * height };
}

async function captureScreenshot(browser, url) {
  const page = await browser.newPage({ viewport });
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForLoadState('networkidle', { timeout: settleTimeoutMilliseconds }).catch(() => {});
  return page.screenshot({ fullPage: true, animations: 'disabled' });
}

export async function runVisualComparison({ baselineUrl, candidateUrl }) {
  let browser;
  try {
    browser = await chromium.launch({ channel: 'chrome' });
  } catch {
    throw new Error('Could not start Google Chrome for the screenshots. Install Google Chrome, then compare again.');
  }
  try {
    const [baselineImage, candidateImage] = await Promise.all([
      captureScreenshot(browser, baselineUrl),
      captureScreenshot(browser, candidateUrl),
    ]);
    return { baselineImage, candidateImage, ...compareImages(baselineImage, candidateImage) };
  } finally {
    await browser.close();
  }
}
