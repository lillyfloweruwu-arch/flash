// Deliberately approximate: voice Settings only needs to warn about phrases
// likely to collide with speech, not pronounce every English word perfectly.
export function countSyllables(phrase: string): number {
  return phrase.match(/[aeiouy]+/gi)?.length ?? 0
}
