// examples/worker-span.ts
// Wide event cho Worker / Background Job — Node.js / BullMQ
// Điểm khác biệt so với HTTP: phải gọi span.end() thủ công

import { trace, context, propagation, SpanStatusCode } from '@opentelemetry/api'

const tracer = trace.getTracer('email-worker')

// --- Processor ---
worker.process('send-email', async (job) => {
  // Restore trace context từ job data (nếu được dispatch từ HTTP request)
  const parentCtx = job.data._otelCtx
    ? propagation.extract(context.active(), job.data._otelCtx)
    : context.active()

  const span = tracer.startSpan(`job.${job.name}`, {}, parentCtx)

  return context.with(trace.setSpan(context.active(), span), async () => {
    // Thêm job context (bắt buộc)
    span.setAttributes({
      'job.id':           job.id?.toString() ?? '',
      'job.name':         job.name,
      'job.queue':        job.queueName,
      'job.attempt':      job.attemptsMade,
      'job.max_retry':    job.opts.attempts ?? 3,
      'job.payload_size': JSON.stringify(job.data).length,
      'user.id':          job.data.userId,
    })

    try {
      await sendEmail(job.data)

      span.setAttributes({ 'job.outcome': 'success' })

    } catch (err) {
      span.setAttributes({ 'job.outcome': 'failed' })
      span.recordException(err as Error)
      span.setStatus({ code: SpanStatusCode.ERROR })
      throw err

    } finally {
      span.end() // ← QUAN TRỌNG: Worker phải tự gọi end(), HTTP thì không cần
    }
  })
})

// --- Dispatcher (trong HTTP handler) ---
export function dispatchEmailJob(userId: string, email: string) {
  // Lưu trace context vào job data để worker restore được
  const otelCtx: Record<string, string> = {}
  propagation.inject(context.active(), otelCtx)

  emailQueue.add('send-email', {
    userId,
    email,
    _otelCtx: otelCtx, // worker đọc cái này
  })
}
