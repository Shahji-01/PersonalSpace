import { searchTokens } from './search';

// Deterministic Devanagari → Latin transliteration for cross-script search.
//
// The goal is recall, not scholarly accuracy: a Hinglish query like "ghar"
// should find the Devanagari note "घर", and a Devanagari query should find a
// note typed in Hinglish. Both the stored text and the query run through the
// same pipeline (transliterate → fuzzy-canonicalise), so they collapse to a
// shared romanised space. Hindi romanisation is not standardised, so we fold
// away the most common ambiguities (vowel length, w/v, z/j) rather than trying
// to reproduce any one scheme exactly.

// A private marker for the inherent schwa of a bare consonant, resolved after
// the whole word is built so we can drop the usual word-final schwa (घर → ghar,
// not "ghara") while keeping medial ones (नमस्ते → namaste).
const SCHWA = '';

const INDEPENDENT_VOWELS: Record<string, string> = {
  अ: 'a',
  आ: 'aa',
  इ: 'i',
  ई: 'ii',
  उ: 'u',
  ऊ: 'uu',
  ऋ: 'ri',
  ए: 'e',
  ऐ: 'ai',
  ओ: 'o',
  औ: 'au',
  ऑ: 'o',
  ऎ: 'e',
  ऒ: 'o',
};

const MATRAS: Record<string, string> = {
  'ा': 'aa', // ा
  'ि': 'i', // ि
  'ी': 'ii', // ी
  'ु': 'u', // ु
  'ू': 'uu', // ू
  'ृ': 'ri', // ृ
  'े': 'e', // े
  'ै': 'ai', // ै
  'ो': 'o', // ो
  'ौ': 'au', // ौ
  'ॉ': 'o', // ॉ
  'ॅ': 'e', // ॅ
};

const VIRAMA = '्'; // ्
const NUKTA = '़'; // ़
const ANUSVARA = 'ं'; // ं
const CHANDRABINDU = 'ँ'; // ँ
const VISARGA = 'ः'; // ः

const CONSONANTS: Record<string, string> = {
  क: 'k',
  ख: 'kh',
  ग: 'g',
  घ: 'gh',
  ङ: 'ng',
  च: 'ch',
  छ: 'chh',
  ज: 'j',
  झ: 'jh',
  ञ: 'ny',
  ट: 't',
  ठ: 'th',
  ड: 'd',
  ढ: 'dh',
  ण: 'n',
  त: 't',
  थ: 'th',
  द: 'd',
  ध: 'dh',
  न: 'n',
  प: 'p',
  फ: 'ph',
  ब: 'b',
  भ: 'bh',
  म: 'm',
  य: 'y',
  र: 'r',
  ल: 'l',
  ळ: 'l',
  व: 'v',
  श: 'sh',
  ष: 'sh',
  स: 's',
  ह: 'h',
};

// Nukta variants, keyed by the base consonant.
const NUKTA_VARIANTS: Record<string, string> = {
  क: 'q',
  ख: 'kh',
  ग: 'g',
  ज: 'z',
  ड: 'r',
  ढ: 'rh',
  फ: 'f',
  य: 'y',
};

const DIGITS: Record<string, string> = {
  '०': '0',
  '१': '1',
  '२': '2',
  '३': '3',
  '४': '4',
  '५': '5',
  '६': '6',
  '७': '7',
  '८': '8',
  '९': '9',
};

/** Transliterate a single string from Devanagari to Latin. Latin passes through. */
export function devanagariToRoman(input: string): string {
  const chars = Array.from(input.normalize('NFC'));
  let out = '';
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i]!;
    const consonant = CONSONANTS[c];
    if (consonant !== undefined) {
      const hasNukta = chars[i + 1] === NUKTA;
      out += hasNukta && NUKTA_VARIANTS[c] !== undefined ? NUKTA_VARIANTS[c] : consonant;
      if (hasNukta) i++;
      const next = chars[i + 1];
      if (next === VIRAMA) {
        i++; // dead consonant: no vowel
      } else if (next !== undefined && MATRAS[next] !== undefined) {
        out += MATRAS[next];
        i++;
      } else {
        out += SCHWA; // inherent schwa, resolved below
      }
      continue;
    }
    if (INDEPENDENT_VOWELS[c] !== undefined) out += INDEPENDENT_VOWELS[c]!;
    else if (c === ANUSVARA || c === CHANDRABINDU) out += 'n';
    else if (c === VISARGA) out += 'h';
    else if (DIGITS[c] !== undefined) out += DIGITS[c]!;
    else if (c === '।' || c === '॥')
      out += ' '; // danda / double danda
    else if (c !== NUKTA) out += c; // pass through Latin, spaces, etc.
  }
  // Drop word-final schwa, keep medial schwa as 'a'.
  return out.replace(new RegExp(`${SCHWA}(?=\\s|$)`, 'g'), '').replaceAll(SCHWA, 'a');
}

/** Fold common romanisation ambiguities so Hinglish and transliterated Hindi align. */
export function canonicalRoman(value: string): string {
  return value
    .normalize('NFC')
    .toLowerCase()
    .replace(/aa+/g, 'a')
    .replace(/(?:ee|ii)+/g, 'i')
    .replace(/(?:oo|uu)+/g, 'u')
    .replaceAll('w', 'v')
    .replaceAll('z', 'j');
}

/**
 * Produce space-joined canonical romanised tokens for indexing or querying.
 * Returns '' when the input has no word tokens.
 */
export function transliterate(value: string): string {
  return searchTokens(value)
    .map((token) => canonicalRoman(devanagariToRoman(token)))
    .filter(Boolean)
    .join(' ');
}
