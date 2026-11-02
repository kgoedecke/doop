// OpenAI documents the Plugins page as the entry point for adding a custom MCP
// server. It does not document a link that prefills an arbitrary server URL.
export const CHATGPT_PLUGINS_URL = 'https://chatgpt.com/plugins'
export const CHATGPT_CONNECTION_GUIDE = 'https://developers.openai.com/plugins/deploy/connect-chatgpt'

export { canUsePublicMcpEndpoint as canUseChatGPTPublicEndpoint } from './mcpConnection'
