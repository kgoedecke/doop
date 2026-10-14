import { authClient } from './auth'
import { useStore } from './store'

/** Chat messages that arrived since this browser last had the chat open,
 *  not counting my own — matched by account, since display names collide. */
export function useChatUnread(): number {
  const myId = authClient.useSession().data?.user.id
  return useStore(
    (s) => s.chat.filter((m) => m.at > s.chatSeenAt && !(m.fromKind === 'user' && m.fromUserId === myId)).length,
  )
}
