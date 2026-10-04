import { describe, expect, it } from 'vitest';
import { canonicalRoman, devanagariToRoman, transliterate } from './transliterate';

describe('devanagariToRoman', () => {
  it('drops the word-final schwa but keeps medial ones', () => {
    expect(devanagariToRoman('घर')).toBe('ghar');
    expect(devanagariToRoman('कल')).toBe('kal');
    expect(devanagariToRoman('नमस्ते')).toBe('namaste');
  });

  it('applies matras, independent vowels and viramas', () => {
    expect(devanagariToRoman('किताब')).toBe('kitaab');
    expect(devanagariToRoman('पानी')).toBe('paanii');
    expect(devanagariToRoman('आम')).toBe('aam');
  });

  it('maps anusvara and nukta consonants', () => {
    expect(devanagariToRoman('हिंदी')).toBe('hindii');
    expect(devanagariToRoman('ज़रा')).toBe('zaraa');
  });

  it('passes Latin text through unchanged', () => {
    expect(devanagariToRoman('ghar')).toBe('ghar');
  });
});

describe('canonicalRoman', () => {
  it('folds vowel length and common consonant variants', () => {
    expect(canonicalRoman('kitaab')).toBe('kitab');
    expect(canonicalRoman('paanii')).toBe('pani');
    expect(canonicalRoman('hindii')).toBe('hindi');
    expect(canonicalRoman('water')).toBe('vater');
    expect(canonicalRoman('zara')).toBe('jara');
  });
});

describe('transliterate', () => {
  it('maps Hindi and Hinglish spellings of a word to the same canonical form', () => {
    for (const pair of [
      ['घर', 'ghar'],
      ['किताब', 'kitaab'],
      ['पानी', 'paani'],
      ['हिंदी', 'hindi'],
    ] as const) {
      const [deva, latin] = pair;
      expect(transliterate(deva)).toBe(transliterate(latin));
      expect(transliterate(deva)).not.toBe('');
    }
  });

  it('tokenises multi-word input and ignores punctuation', () => {
    expect(transliterate('मेरा घर!')).toBe('mera ghar');
    expect(transliterate('   ')).toBe('');
  });
});
