import { createGeminiCloudWorker } from './geminiCloudWorker.ts'

const worker = createGeminiCloudWorker({
  token: process.env.GEMINI_WORKER_TOKEN ?? '',
  origin: process.env.DOOP_ORIGIN ?? '',
})
const server = worker.app.listen(Number(process.env.PORT || 4401), '0.0.0.0', () => {
  console.log('Gemini cloud pilot worker listening')
})
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    worker.stop()
    server.close()
  })
}
