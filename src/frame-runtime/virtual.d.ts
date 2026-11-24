declare module 'virtual:frame-runtime' {
  /** The frame runtime (src/frame-runtime/main.ts) built into one classic
   *  script by src/frame-runtime/vitePlugin.ts, for FRAME_BOOTSTRAP to inline. */
  const script: string
  export default script
}
