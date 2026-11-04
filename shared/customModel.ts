/** The one validator for a user-typed custom model id. Custom endpoints are
 *  not one vendor: the id is passed through, so only length and a conservative
 *  character set are enforced — never an OpenAI/Gemini family regex. */
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$/

export function isCustomModelId(value: unknown): value is string {
  return typeof value === 'string' && MODEL_ID.test(value)
}
