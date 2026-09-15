'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  DEFAULT_PROGRESS_SELECTOR,
  collectImageCandidates,
  findActiveTurn,
  imageScanDecision,
  inspectActiveImageProgress,
  isImageLoadReady,
  parseProgressValue,
  progressBlocksCompletion,
  readTurnProgress,
} = require('../src/image-progress.cjs');

const ASSISTANT_SELECTOR = '[data-message-author-role="assistant"], .agent-turn';

class FakeElement {
  constructor({
    attrs = {},
    textContent = '',
    images = [],
    markers = [],
    hints = [],
    className = '',
    parentElement = null,
  } = {}) {
    this.attrs = { ...attrs };
    this.textContent = textContent;
    this.innerText = textContent;
    this.images = images;
    this.markers = markers;
    this.hints = hints;
    this.className = className;
    this.parentElement = parentElement;
    this.parentNode = parentElement;
  }

  getAttribute(name) {
    return this.attrs[name] == null ? null : this.attrs[name];
  }

  matches(selector) {
    return selector === '.agent-turn' && this.className.split(/\s+/).includes('agent-turn');
  }

  closest(selector) {
    let current = this;
    while (current) {
      if (current.matches && current.matches(selector)) return current;
      current = current.parentElement;
    }
    return null;
  }

  querySelectorAll(selector) {
    if (selector === 'img') return this.images;
    if (selector === DEFAULT_PROGRESS_SELECTOR) return this.markers;
    if (selector.includes('[data-testid="image-gen-loading-state-frame"]')) return this.hints;
    return [];
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }
}

class FakeDocument {
  constructor(turns) {
    this.turns = turns;
  }

  querySelectorAll(selector) {
    if (selector === ASSISTANT_SELECTOR) return this.turns;
    return [];
  }
}

function marker(value, { ariaValue = value, text = `${value}%` } = {}) {
  const attrs = {
    'data-testid': 'image-gen-loading-progress',
    role: 'progressbar',
    'aria-valuemin': '0',
    'aria-valuemax': '100',
  };
  if (ariaValue != null) attrs['aria-valuenow'] = String(ariaValue);
  return new FakeElement({ attrs, textContent: text });
}

function image({ src = 'https://chatgpt.com/backend-api/estuary/content?id=1', complete = true, naturalWidth = 1024 } = {}) {
  return {
    src,
    alt: 'generated',
    complete,
    naturalWidth,
    naturalHeight: naturalWidth,
    getAttribute(name) {
      return name === 'src' ? src : null;
    },
  };
}

function turn({ markers = [], images = [], hints = [], className = 'agent-turn', textContent = '' } = {}) {
  return new FakeElement({ markers, images, hints, className, textContent });
}

function inspect(turns, initialAssistantCount = 0) {
  return inspectActiveImageProgress({
    document: new FakeDocument(turns),
    assistantSelector: ASSISTANT_SELECTOR,
    initialAssistantCount,
  });
}

test('reads the exact ChatGPT marker and keeps 0..99 pending', () => {
  const result = inspect([turn({ markers: [marker(27)] })]);

  assert.equal(result.isNew, true);
  assert.equal(result.markerPresent, true);
  assert.equal(result.progress, 27);
  assert.equal(result.progressState, 'pending');
  assert.equal(progressBlocksCompletion(result), true);
});

test('uses marker text only as a percent fallback', () => {
  const result = inspect([turn({ markers: [marker(null, { ariaValue: null, text: '42%' })] })]);

  assert.equal(result.progress, 42);
  assert.equal(result.progressSource, 'text');
});

test('accepts only bounded, complete percent values', () => {
  assert.equal(parseProgressValue('0%', true), 0);
  assert.equal(parseProgressValue('100%', true), 100);
  assert.equal(parseProgressValue('-10%', true), null);
  assert.equal(parseProgressValue('101%', true), null);
  assert.equal(parseProgressValue('1000%', true), null);
  assert.equal(parseProgressValue('NaN%', true), null);
});

test('100% stays blocked until every generated image is load ready', () => {
  const pendingImage = image({ complete: false, naturalWidth: 0 });
  const currentTurn = turn({ markers: [marker(100)], images: [pendingImage] });
  const beforeLoad = inspect([currentTurn]);

  assert.equal(beforeLoad.progress, 100);
  assert.equal(beforeLoad.readyCount, 0);
  assert.equal(beforeLoad.allReady, false);
  assert.equal(progressBlocksCompletion(beforeLoad), true);
  assert.equal(imageScanDecision({
    progress: beforeLoad,
    candidateCount: 1,
    imageCount: 0,
    allImagesReady: false,
    hasImageHint: true,
  }).shouldRetry, true);

  pendingImage.complete = true;
  pendingImage.naturalWidth = 1024;
  pendingImage.naturalHeight = 1024;
  const afterLoad = inspect([currentTurn]);

  assert.equal(afterLoad.allReady, true);
  assert.equal(progressBlocksCompletion(afterLoad), false);
  assert.equal(imageScanDecision({
    progress: afterLoad,
    candidateCount: 1,
    imageCount: 1,
    allImagesReady: true,
    hasImageHint: true,
  }).canReturnImages, true);
});

test('treats mixed progress markers conservatively while a lower value remains', () => {
  const result = inspect([turn({ markers: [marker(20), marker(100)] })]);

  assert.equal(result.progress, 20);
  assert.equal(result.progressState, 'pending');
  assert.equal(progressBlocksCompletion(result), true);
});

test('does not latch progress when the marker disappears during preview', () => {
  const generatedImage = image();
  const currentTurn = turn({ markers: [marker(70)], images: [generatedImage] });
  assert.equal(inspect([currentTurn]).progress, 70);

  currentTurn.markers = [];
  const disappeared = inspect([currentTurn]);
  assert.equal(disappeared.markerPresent, false);
  assert.equal(disappeared.progress, null);
  assert.equal(disappeared.progressState, 'none');

  const previewDecision = imageScanDecision({
    generationActive: true,
    progress: disappeared,
    candidateCount: 1,
    imageCount: 1,
    allImagesReady: true,
    hasImageHint: true,
  });
  assert.equal(previewDecision.canReturnImages, false);
  assert.equal(previewDecision.shouldRetry, true);

  const finalDecision = imageScanDecision({
    generationActive: false,
    progress: disappeared,
    candidateCount: 1,
    imageCount: 1,
    allImagesReady: true,
    hasImageHint: true,
  });
  assert.equal(finalDecision.canReturnImages, true);
});

test('reports a retreat or restart in the current marker value', () => {
  const currentTurn = turn({ markers: [marker(70)] });
  assert.equal(inspect([currentTurn]).progress, 70);

  currentTurn.markers = [marker(35)];
  assert.equal(inspect([currentTurn]).progress, 35);
});

test('waits for all distinct images in a multi-image response', () => {
  const images = [
    image({ src: 'https://chatgpt.com/backend-api/estuary/content?id=1' }),
    image({ src: 'https://chatgpt.com/backend-api/estuary/content?id=2' }),
  ];
  const currentTurn = turn({ markers: [marker(100)], images });
  const result = inspect([currentTurn]);

  assert.equal(result.candidateCount, 2);
  assert.equal(result.readyCount, 2);
  assert.equal(collectImageCandidates(currentTurn).length, 2);
  assert.equal(imageScanDecision({
    progress: result,
    candidateCount: 2,
    imageCount: 1,
    allImagesReady: true,
    hasImageHint: true,
  }).canReturnImages, false);
});

test('ignores an ordinary article percentage without the exact marker', () => {
  const result = inspect([turn({ textContent: 'The article reports 73% completion.' })]);

  assert.equal(result.markerPresent, false);
  assert.equal(result.progress, null);
  assert.equal(result.hasImageHint, false);
});

test('does not inspect an old turn when no new assistant turn exists', () => {
  const oldTurn = turn({ markers: [marker(99)] });
  const result = inspect([oldTurn], 1);

  assert.equal(result.hasTurn, false);
  assert.equal(result.isNew, false);
  assert.equal(result.progress, null);
});

test('normalizes a nested assistant marker to its outer agent turn', () => {
  const outerTurn = turn({ markers: [marker(27)] });
  const nestedAssistant = new FakeElement({
    attrs: { 'data-message-author-role': 'assistant' },
    parentElement: outerTurn,
  });
  const turns = [outerTurn, nestedAssistant];
  const document = new FakeDocument(turns);

  assert.equal(findActiveTurn({
    document,
    assistantSelector: ASSISTANT_SELECTOR,
    initialAssistantCount: 0,
  }), outerTurn);
  assert.equal(inspectActiveImageProgress({
    document,
    assistantSelector: ASSISTANT_SELECTOR,
    initialAssistantCount: 0,
  }).progress, 27);
});

test('normalizes nested agent turns to the outermost agent turn', () => {
  const outerTurn = turn({ markers: [marker(27)], images: [image()] });
  const nestedTurn = new FakeElement({
    className: 'agent-turn',
    parentElement: outerTurn,
  });
  const document = new FakeDocument([nestedTurn]);

  const result = inspectActiveImageProgress({
    document,
    assistantSelector: ASSISTANT_SELECTOR,
    initialAssistantCount: 0,
  });

  assert.equal(findActiveTurn({
    document,
    assistantSelector: ASSISTANT_SELECTOR,
    initialAssistantCount: 0,
  }), outerTurn);
  assert.equal(result.progress, 27);
  assert.equal(result.candidateCount, 1);
});

test('chooses the latest response across selectors without a baseline', () => {
  const latestSelector = '[data-testid="fallback-response"]';
  const oldTurn = turn({ markers: [marker(20)] });
  const latestFallback = new FakeElement({
    attrs: { 'data-testid': 'fallback-response' },
    markers: [marker(80)],
  });
  const document = {
    querySelectorAll(selector) {
      if (selector === ASSISTANT_SELECTOR) return [oldTurn];
      if (selector === latestSelector) return [latestFallback];
      if (selector === `${ASSISTANT_SELECTOR}, ${latestSelector}`) {
        return [oldTurn, latestFallback];
      }
      return [];
    },
  };

  const result = inspectActiveImageProgress({
    document,
    assistantSelector: ASSISTANT_SELECTOR,
    latestSelector,
  });

  assert.equal(result.progress, 80);
});

test('keeps no-progress responses on the existing image readiness fallback', () => {
  const currentTurn = turn({ images: [image()] });
  const result = inspect([currentTurn]);

  assert.equal(result.markerPresent, false);
  assert.equal(result.allReady, true);
  assert.equal(imageScanDecision({
    chatgptProgress: false,
    progress: result,
    candidateCount: 1,
    imageCount: 1,
    allImagesReady: true,
    hasImageHint: true,
  }).canReturnImages, true);
});

test('keeps pending scans retryable for the Rust wall-clock timeout', () => {
  const decision = imageScanDecision({
    progress: { markerPresent: true, progress: 12 },
    candidateCount: 0,
    imageCount: 0,
    allImagesReady: false,
    hasImageHint: true,
  });

  assert.equal(decision.canReturnImages, false);
  assert.equal(decision.shouldRetry, true);
  assert.equal(isImageLoadReady(image({ complete: false, naturalWidth: 0 })), false);
});


test('text-only ChatGPT toolbars with mask-image CSS do not trigger image retries', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const vm = require('node:vm');
  const rust = fs.readFileSync(path.join(__dirname, '../src/main.rs'), 'utf8');
  const helper = fs.readFileSync(path.join(__dirname, '../src/image-progress.cjs'), 'utf8');
  const template = rust.slice(rust.indexOf('fn build_image_scan_script('))
    .match(/r###"([\s\S]*?)"###/)[1];
  const replacements = {
    __IMAGE_PROGRESS_HELPER__: helper,
    __CHATGPT_PROGRESS__: 'true',
    __LATEST_SELECTOR__: JSON.stringify(ASSISTANT_SELECTOR),
    __ASSISTANT_SELECTOR__: JSON.stringify(ASSISTANT_SELECTOR),
    __INITIAL_ASSISTANT_COUNT__: '0',
    __STOP_SELECTORS__: '[]',
    __IMAGE_WAIT_TIMEOUT_MS__: '100',
  };
  let script = template;
  for (const [placeholder, value] of Object.entries(replacements)) {
    script = script.split(placeholder).join(value);
  }

  const latest = turn({ textContent: 'ABIMG-TEXT-OK' });
  const toolbar = new FakeElement({ className: '[mask-image:linear-gradient(to_right,black,transparent)]' });
  latest.querySelector = (selector) => selector.includes('[class*="image"]') ? toolbar : null;
  const context = {
    document: new FakeDocument([latest]),
    performance: { now: () => 0 },
    setTimeout,
    clearTimeout,
  };
  context.window = context;
  vm.runInNewContext(`(${script})()`, context);

  assert.equal(context.__downloaded_images_status, 'success');
  assert.equal(context.__downloaded_images.images.length, 0);
  assert.equal(context.__downloaded_images.shouldRetry, false);
});
