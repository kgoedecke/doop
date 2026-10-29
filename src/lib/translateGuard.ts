/* Browser page translation (Chrome's Google Translate, Edge's translator)
   swaps the text nodes React rendered for <font> wrappers of its own. React
   still holds the old nodes, so its next update calls removeChild or
   insertBefore with a node that is no longer a child, the DOM throws
   NotFoundError, and the whole tree unmounts (facebook/react#11538). Skipping
   the call when the node has moved keeps the page alive; the translated text
   goes stale until the next translation pass, which is what users see on
   every other React site too. */
export function installTranslateGuard() {
  const proto = Node.prototype
  const removeChild = proto.removeChild
  const insertBefore = proto.insertBefore

  proto.removeChild = function <T extends Node>(this: Node, child: T): T {
    if (child.parentNode !== this) return child
    return removeChild.call(this, child) as T
  }

  proto.insertBefore = function <T extends Node>(this: Node, node: T, ref: Node | null): T {
    if (ref && ref.parentNode !== this) return node
    return insertBefore.call(this, node, ref) as T
  }
}
