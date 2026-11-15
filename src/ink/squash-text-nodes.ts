import type { DOMElement } from './dom.js'
import type { TextStyles } from './styles.js'

/**
 * A segment of text with its associated styles.
 * Used for structured rendering without ANSI string transforms.
 */
export type StyledSegment = {
  text: string
  styles: TextStyles
  hyperlink?: string
  /**
   * The nested text node that owns this run, when it comes from a child
   * `<Text>` rather than from the painted node's own characters. The
   * renderer records such a node's painted cell in `nodeCache`, which is how
   * an input caret rendered INSIDE a wrapping text can park the native
   * cursor on its own cell (a sibling caret would sit on the block's corner).
   */
  origin?: DOMElement
}

/**
 * Squash text nodes into styled segments, propagating styles down through the tree.
 * This allows structured styling without relying on ANSI string transforms.
 * @param node - the subtree root whose text nodes are collected.
 * @param inheritedStyles - styles inherited from ancestors, merged with the node's own.
 * @param inheritedHyperlink - the hyperlink inherited from ancestor ink-link elements.
 * @param out - the array segments are appended to; defaults to a fresh array.
 * @param owner - the nested text node that owns the run; unset for the
 *   painted node's own characters.
 * @returns `out` containing one segment per non-empty text node.
 */
export function squashTextNodesToSegments(
  node: DOMElement,
  inheritedStyles: TextStyles = {},
  inheritedHyperlink?: string,
  out: StyledSegment[] = [],
  owner?: DOMElement,
): StyledSegment[] {
  const mergedStyles = node.textStyles
    ? { ...inheritedStyles, ...node.textStyles }
    : inheritedStyles

  for (const childNode of node.childNodes) {
    if (childNode === undefined) {
      continue
    }

    if (childNode.nodeName === '#text') {
      if (childNode.nodeValue.length > 0) {
        out.push({
          text: childNode.nodeValue,
          styles: mergedStyles,
          hyperlink: inheritedHyperlink,
          ...(owner === undefined ? {} : { origin: owner }),
        })
      }
    } else if (
      childNode.nodeName === 'ink-text' ||
      childNode.nodeName === 'ink-virtual-text'
    ) {
      squashTextNodesToSegments(
        childNode,
        mergedStyles,
        inheritedHyperlink,
        out,
        childNode,
      )
    } else if (childNode.nodeName === 'ink-link') {
      const href = childNode.attributes['href'] as string | undefined
      squashTextNodesToSegments(
        childNode,
        mergedStyles,
        href || inheritedHyperlink,
        out,
        owner,
      )
    }
  }

  return out
}

/**
 * Squash text nodes into a plain string (without styles).
 * Used for text measurement in layout calculations.
 * @param node - the subtree root whose text nodes are concatenated.
 * @returns the concatenated text content of every text node in the subtree.
 */
function squashTextNodes(node: DOMElement): string {
  let text = ''

  for (const childNode of node.childNodes) {
    if (childNode === undefined) {
      continue
    }

    if (childNode.nodeName === '#text') {
      text += childNode.nodeValue
    } else if (
      childNode.nodeName === 'ink-text' ||
      childNode.nodeName === 'ink-virtual-text'
    ) {
      text += squashTextNodes(childNode)
    } else if (childNode.nodeName === 'ink-link') {
      text += squashTextNodes(childNode)
    }
  }

  return text
}

export default squashTextNodes
