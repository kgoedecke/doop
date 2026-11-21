/** An agent's write refused before anything of it was saved, carrying what to tell the agent.
 *  Thrown inside the write, so the operation's write boundary (server/journal.ts) undoes what it
 *  had begun; the MCP tool boundary (server/toolLoads.ts), the component tools
 *  (`runComponentTool`) and the resident's tool call answer with the message. */
export class WriteRefusedError extends Error {
  override name = 'WriteRefusedError'
}
