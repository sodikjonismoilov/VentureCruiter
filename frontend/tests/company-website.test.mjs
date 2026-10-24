import { test } from 'node:test';
import assert from 'node:assert/strict';
import { companyWebsite } from '../src/lib/company-website.ts';

test('a bare company domain gains HTTPS while explicit secure paths are retained', () => {
  assert.equal(companyWebsite(' hivesales.io '), 'https://hivesales.io/');
  assert.equal(companyWebsite('www.hivesales.io/company'), 'https://www.hivesales.io/company');
  assert.equal(companyWebsite('https://hivesales.io/about?lang=en'), 'https://hivesales.io/about?lang=en');
});

test('invalid, insecure, local and credential-bearing inputs have actionable inline messages', () => {
  for (const input of ['', 'not a website', 'localhost', '127.0.0.1', 'https://user:password@hivesales.io', 'http://hivesales.io', 'javascript:alert(1)']) {
    assert.throws(() => companyWebsite(input), /Enter|Use/);
  }
});
