// examples/nodejs-http-span.ts
// Wide event cho HTTP API — Node.js / Express
// Copy và adapt cho service của bạn

import { trace, SpanStatusCode } from '@opentelemetry/api'

router.post('/orders', async (req, res) => {
  const span = trace.getActiveSpan()

  // --- Thêm business context ngay đầu handler ---
  span?.setAttributes({
    // User context (bắt buộc)
    'user.id':   req.user.id,
    'user.plan': req.user.plan,

    // Domain-specific (thay bằng entity của service bạn)
    'order.total':      req.body.total,
    'order.item_count': req.body.items.length,
    'payment.method':   req.body.paymentMethod,

    // Feature flag nếu có
    'feature.flag': getFeatureFlag('new-checkout', req.user.id),
  })

  try {
    const order = await orderService.create(req.body, req.user)

    // Thêm kết quả sau khi xử lý
    span?.setAttributes({
      'order.id':        order.id,
      'order.status':    order.status,
      'request.outcome': 'success',
    })

    res.status(201).json(order)

  } catch (err) {
    span?.recordException(err as Error)
    span?.setStatus({ code: SpanStatusCode.ERROR, message: (err as Error).message })
    span?.setAttributes({
      'error.type':        (err as Error).constructor.name,
      'error.code':        (err as any).code ?? 'UNKNOWN',
      'error.is_retryable': false,
      'request.outcome':   'error',
    })
    throw err
  }
})
