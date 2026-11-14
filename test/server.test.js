const test = require('node:test');
const assert = require('node:assert');
process.env.APP_PIN = 'test-pin';
process.env.DATA_DIR = require('os').tmpdir() + '/nas-test-' + process.pid;
const { validSchedule } = require('../server.js');

test('validSchedule accepts recurring and one-time', () => {
  assert.strictEqual(validSchedule({ action: 'off', time: '23:00', days: [1, 2] }), null);
  assert.strictEqual(validSchedule({ action: 'on', time: '07:30', days: [], date: '2026-12-01' }), null);
});
test('validSchedule rejects bad input', () => {
  assert.ok(validSchedule({ action: 'nuke', time: '23:00', days: [1] }));
  assert.ok(validSchedule({ action: 'off', time: '25:00', days: [1] }));
  assert.ok(validSchedule({ action: 'off', time: '23:00', days: [9] }));
  assert.ok(validSchedule({ action: 'off', time: '23:00', days: [] }));
});
