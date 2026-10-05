// Numbers are written three ways in titles: "7 Chances", "Seven Chances", "Part II".
// Indexers match release names literally, so PiRick treats the forms as equal.

const SMALL_NUMBERS = [
  'zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
  'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen', 'twenty',
];
const ROUND_NUMBERS = { thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90, hundred: 100, thousand: 1000 };
// I, V and X are left out: on their own they are usually words or titles ("X", "V for Vendetta").
const ROMAN_NUMERALS = ['', '', 'ii', 'iii', 'iv', '', 'vi', 'vii', 'viii', 'ix', '', 'xi', 'xii', 'xiii', 'xiv', 'xv', 'xvi', 'xvii', 'xviii', 'xix', 'xx'];

const WORD_VALUES = new Map([...SMALL_NUMBERS.map((word, value) => [word, value]), ...Object.entries(ROUND_NUMBERS)]);
const ROMAN_VALUES = new Map(ROMAN_NUMERALS.map((numeral, value) => [numeral, value]).filter(([numeral]) => numeral));

/** The number a word stands for ("nine" is 9), or null. */
export const numberFromWord = (word) => WORD_VALUES.get(word.toLowerCase()) ?? null;
/** The number a roman numeral stands for ("III" is 3), or null. */
export const numberFromRoman = (word) => ROMAN_VALUES.get(word.toLowerCase()) ?? null;
/** "nine" for 9, or null when there is no single word for it. */
export const wordForNumber = (value) => SMALL_NUMBERS[value] ?? Object.keys(ROUND_NUMBERS).find((word) => ROUND_NUMBERS[word] === value) ?? null;
/** "III" for 3, or null. */
export const romanForNumber = (value) => ROMAN_NUMERALS[value]?.toUpperCase() || null;

/**
 * One word of a title in the form used for comparing: lower case, with "nine",
 * "IX" and "09" all becoming "9".
 */
export function canonicalWord(word) {
  const lower = word.toLowerCase();
  const value = numberFromWord(lower) ?? numberFromRoman(lower);
  if (value != null) return String(value);
  return /^\d+$/.test(lower) ? String(Number(lower)) : lower;
}
