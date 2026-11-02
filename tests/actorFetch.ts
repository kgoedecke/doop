/* Frame actors answer over HTTP (fetch) too. A test that stubs the global
   fetch for an integration's upstream must let actor RPC through untouched. */
const actorOrigin = process.env.TERSE_ACTOR_URL ? new URL(process.env.TERSE_ACTOR_URL).origin : undefined

export function isActorRequest(url: string | URL | Request): boolean {
  const target = url instanceof Request ? url.url : String(url)
  return !!actorOrigin && target.startsWith(actorOrigin)
}
