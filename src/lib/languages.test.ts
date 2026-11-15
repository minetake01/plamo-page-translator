import { describe, expect, it } from 'vitest';
import { isProbablyTarget, normalizeLanguage } from './languages';

describe('normalizeLanguage', () => {
  it('normalizes browser tags to PLaMo codes', () => {
    expect(normalizeLanguage('ja-JP')).toBe('ja');
    expect(normalizeLanguage('en-US')).toBe('en');
    expect(normalizeLanguage('zh-CN')).toBe('zh-hans');
    expect(normalizeLanguage('zh-TW')).toBe('zh-hant');
    expect(normalizeLanguage('xx')).toBeUndefined();
  });
});

describe('isProbablyTarget', () => {
  it('detects Japanese by kana', () => {
    expect(isProbablyTarget('会議は来週の月曜日に変更されました。', 'ja')).toBe(true);
    expect(isProbablyTarget('The meeting was moved.', 'ja')).toBe(false);
  });

  it('does not treat English technical text as Japanese', () => {
    expect(isProbablyTarget('The API returns a JSON object. failover_mode', 'ja')).toBe(false);
  });
});
