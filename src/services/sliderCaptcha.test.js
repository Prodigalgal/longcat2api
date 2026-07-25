import test from 'node:test';
import assert from 'node:assert/strict';

import { mapGapToDrag } from './sliderCaptcha.js';

test('maps the visible piece offset instead of the moving strip edge', () => {
  const result = mapGapToDrag({
    gapLeftCss: 180,
    pieceLeft: 0,
    maxTravel: 252,
    imgW: 296,
    pieceW: 44,
    pieceOffset: 28,
  });

  assert.equal(result.targetPiece, 152);
  assert.equal(result.drag, 152);
});

test('subtracts the current strip position for a follow-up drag', () => {
  const result = mapGapToDrag({
    gapLeftCss: 180,
    pieceLeft: 20,
    maxTravel: 252,
    imgW: 296,
    pieceW: 44,
    pieceOffset: 28,
  });

  assert.equal(result.targetPiece, 152);
  assert.equal(result.drag, 132);
});

test('clamps against the visible piece right edge', () => {
  const result = mapGapToDrag({
    gapLeftCss: 280,
    pieceLeft: 0,
    maxTravel: 252,
    imgW: 296,
    pieceW: 44,
    pieceOffset: 28,
  });

  assert.equal(result.targetPiece, 223);
  assert.equal(result.drag, 223);
});

test('allows a far-right hole while accounting for the inner offset', () => {
  const result = mapGapToDrag({
    gapLeftCss: 250,
    pieceLeft: 0,
    maxTravel: 252,
    imgW: 296,
    pieceW: 44,
    pieceOffset: 28,
  });

  assert.equal(result.targetPiece, 222);
  assert.equal(result.drag, 222);
});
