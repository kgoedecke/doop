import { createGeminiCloudWorker } from './geminiCloudWorker.ts'

const worker = createGeminiCloudWorker({
  token: process.env.GEMINI_WORKER_TOKEN ?? '',
  origin: process.env.DOOP_ORIGIN ?? '',
})
/* Express 5 hands a listen error (a port in use) to this callback instead of throwing it */
const server = worker.app.listen(Number(process.env.PORT || 4401), '0.0.0.0', (error) => {
  if (error) throw error
  console.log('Gemini cloud pilot worker listening')
})
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    worker.stop()
    server.close()
  })
}
