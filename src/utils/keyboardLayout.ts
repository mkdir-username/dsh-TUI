/**
 * Cyrillic layout mirror for modifier shortcuts.
 *
 * Cmd+С and Cmd+C are the same physical key, but the terminal delivers the
 * Cyrillic codepoint, so a Russian layout hid every Ctrl/Cmd shortcut from the
 * matcher. Translating the letter back to the Latin one on the same key makes
 * the shortcut layout-independent. Only Ctrl/Super pass through the mirror:
 * plain typing and pastes must insert the letter the user actually pressed.
 */

/** Cyrillic letters sit on the same physical keys as these Latin symbols. */
const RU_LAYOUT_TO_LATIN: Record<string, string> = {
  'й': 'q', 'ц': 'w', 'у': 'e', 'к': 'r', 'е': 't', 'н': 'y', 'г': 'u', 'ш': 'i',
  'щ': 'o', 'з': 'p', 'х': '[', 'ъ': ']', 'ф': 'a', 'ы': 's', 'в': 'd', 'а': 'f',
  'п': 'g', 'р': 'h', 'о': 'j', 'л': 'k', 'д': 'l', 'ж': ';', 'э': "'", 'я': 'z',
  'ч': 'x', 'с': 'c', 'м': 'v', 'и': 'b', 'т': 'n', 'ь': 'm', 'б': ',', 'ю': '.', 'ё': '`',
}

export function normalizeLayoutChar(value: string): string {
  return RU_LAYOUT_TO_LATIN[value.toLowerCase()] ?? value
}

/** The modifier flags the mirror cares about (a subset of the ink `Key`). */
export interface LayoutKeyFlags {
  readonly ctrl?: boolean
  readonly super?: boolean
}

/** Translate one pressed character for a Ctrl/Cmd combo; anything else as-is. */
export function normalizeLayoutKey(value: string, key: LayoutKeyFlags | undefined): string {
  if (typeof value !== 'string' || [...value].length !== 1) return value
  if (!(key?.ctrl || key?.super)) return value
  return normalizeLayoutChar(value)
}
