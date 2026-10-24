import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readAttachment, readTaskAttachments } from '../src/lib/attachments.ts';

const file = { name: 'screenshot.png' };
function reader(action) {
  globalThis.FileReader = class {
    readAsDataURL() { queueMicrotask(() => action(this)); }
    abort() { this.onabort?.(); }
  };
}
test('image bytes survive file reading', async () => {
  reader(r => { r.result = 'data:image/png;base64,cGl4ZWxz'; r.onload(); });
  assert.deepEqual(await readAttachment(file, 'image/png'), { name: file.name, mime: 'image/png', data: 'cGl4ZWxz' });
});
test('aborted file reading rejects with recovery instead of hanging', async () => {
  reader(r => r.abort());
  await assert.rejects(readAttachment(file, 'image/png'), /interrupted.*Select it again/);
});
test('a stalled file read times out', async () => {
  reader(() => {});
  await assert.rejects(readAttachment(file, 'image/png', 5), /timed out/);
});
test('empty or failed reads reject', async () => {
  reader(r => { r.result = 'data:image/png;base64,'; r.onload(); });
  await assert.rejects(readAttachment(file, 'image/png'), /empty or unreadable/);
  reader(r => r.onerror());
  await assert.rejects(readAttachment(file, 'image/png'), /could not be read/);
});

test('home task attachments retain file bytes and use the supported extension for generic MIME', async () => {
  reader(r => { r.result = 'data:application/pdf;base64,cGRm'; r.onload(); });
  assert.deepEqual(await readTaskAttachments([{ name: 'brief.pdf', type: 'application/octet-stream', size: 3 }]),
    [{ name: 'brief.pdf', mime: 'application/pdf', data: 'cGRm' }]);
});

test('home task attachment limits and unsupported files fail before reading', async () => {
  let reads = 0;
  globalThis.FileReader = class { readAsDataURL() { reads++; } };
  await assert.rejects(readTaskAttachments(Array(5).fill({ name: 'brief.pdf', size: 1 })), /four files/);
  await assert.rejects(readTaskAttachments([{ name: 'large.pdf', size: 3 * 1024 * 1024 + 1 }]), /3 MB/);
  await assert.rejects(readTaskAttachments([{ name: 'script.exe', type: 'application/octet-stream', size: 1 }]), /choose an image/);
  assert.equal(reads, 0);
});
