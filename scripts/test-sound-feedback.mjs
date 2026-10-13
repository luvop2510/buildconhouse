import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

function load(file, mocks = {}) {
  const exports = {};
  const source = readFileSync(new URL(file, import.meta.url), 'utf8');
  vm.runInNewContext(ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, { exports, Promise, ...mocks });
  return exports.playAddProductSound;
}

const errors = [];
const onRejection = error => errors.push(error);
process.on('unhandledRejection', onRejection);
try {
  let creates = 0, plays = 0;
  const audio = { currentTime: 9, play() { plays++; return Promise.reject(new DOMException('Unsupported codec', 'NotSupportedError')); } };
  const play = load('../src/services/soundService.web.ts', {
    Audio: function () { creates++; return audio; },
    require: id => id === 'expo-asset' ? { Asset: { fromModule: () => ({ uri: '/assets/add-product.wav' }) } } : 'fixture.wav',
  });
  play(); play();
  assert.equal(creates, 1, 'Feedback reuses one player instead of decoding a new asset on every add');
  assert.equal(plays, 2);
  assert.equal(audio.currentTime, 0);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(errors.length, 0, 'Rejected browser playback is observed without uncaught errors');

  assert.doesNotThrow(load('../src/services/soundService.web.ts', {
    Audio: function () { throw new Error('No audio driver'); },
    require: () => ({ Asset: { fromModule: () => ({ uri: 'fixture.wav' }) } }),
  }));
  assert.doesNotThrow(load('../src/services/soundService.web.ts', { require: () => ({}) }));

  const nativePlay = load('../src/services/soundService.ts', {
    require: id => id === 'expo-audio' ? { createAudioPlayer: () => ({
      seekTo: () => Promise.reject(new Error('Seek unavailable')), play: () => {},
    }) } : 'fixture.wav',
  });
  nativePlay();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(errors.length, 0, 'Native asynchronous seeking cannot break the add flow');
} finally {
  process.removeListener('unhandledRejection', onRejection);
}
console.log('Web/native optional feedback catches asynchronous failures and reuses playback');
