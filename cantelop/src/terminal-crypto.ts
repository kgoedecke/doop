// Self-contained Web Crypto helper, shared by the browser and native Session.
// Only ciphertext and public keys pass through Cantelop's message/event transport.
export function terminalCrypto() {
  const encode = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes))
  const decode = (text: string): Uint8Array<ArrayBuffer> => Uint8Array.from(atob(text), (c) => c.charCodeAt(0))
  return {
    async generate() {
      const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveKey'])
      return { privateKey: pair.privateKey, publicKey: await crypto.subtle.exportKey('jwk', pair.publicKey) }
    },
    async derive(privateKey: CryptoKey, publicKey: JsonWebKey) {
      const peer = await crypto.subtle.importKey('jwk', publicKey, { name: 'ECDH', namedCurve: 'P-256' }, false, [])
      return crypto.subtle.deriveKey(
        { name: 'ECDH', public: peer },
        privateKey,
        { name: 'AES-GCM', length: 256 },
        false,
        ['encrypt', 'decrypt'],
      )
    },
    async seal(key: CryptoKey, text: string, context: string) {
      const iv = crypto.getRandomValues(new Uint8Array(12))
      const bytes = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(context) },
        key,
        new TextEncoder().encode(text),
      )
      return { iv: encode(iv), data: encode(new Uint8Array(bytes)) }
    },
    async open(key: CryptoKey, frame: { iv: string; data: string }, context: string) {
      const bytes = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: decode(frame.iv), additionalData: new TextEncoder().encode(context) },
        key,
        decode(frame.data),
      )
      return new TextDecoder().decode(bytes)
    },
  }
}
