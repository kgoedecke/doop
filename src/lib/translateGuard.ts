/* Browser page translation (Chrome's Google Translate, Edge's translator)
   swaps the text nodes React rendered for <font> wrappers of its own. React
   still holds the old nodes, so its next update calls removeChild or
   insertBefore with a node that is no longer a child, the DOM throws
   NotFoundError, and the whole tree unmounts (facebook/react#11538). A remove
   of a node that has moved is skipped; the translated text goes stale until
   the next translation pass, which is what users see on every other React
   site too. An insert still lands: before the wrapper that now holds the
   reference node, or at the end when the reference left the parent. */
export function installTranslateGuard() {
  const proto = Node.prototype
  const removeChild = proto.removeChild
  const insertBefore = proto.insertBefore

  proto.removeChild = function <T extends Node>(this: Node, child: T): T {
    if (child.parentNode !== this) return child
    return removeChild.call(this, child) as T
  }

  proto.insertBefore = function <T extends Node>(this: Node, node: T, ref: Node | null): T {
    return insertBefore.call(this, node, ref && childHolding(this, ref)) as T
  }
}

/** The child of `parent` that is or contains `node`, or null when `node` is
 *  not under `parent` at all (insertBefore then appends). */
function childHolding(parent: Node, node: Node): Node | null {
  let current: Node | null = node
  while (current && current.parentNode !== parent) current = current.parentNode
  return current
}
