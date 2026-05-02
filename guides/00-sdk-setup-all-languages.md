# OTel Wide Event — Hướng dẫn cho Developer

> **Mục tiêu:** Mỗi service emit wide events đúng chuẩn để team có thể debug toàn bộ request flow từ HyperDX mà không cần nhảy giữa nhiều tool.
>
> **Thời gian setup:** ~30 phút per service.  

---

## Nắm 3 điều trước khi bắt đầu

**1. Wide event là gì**

Mỗi request → 1 span duy nhất chứa toàn bộ context. Không phải log từng dòng, không phải counter metric — mà là một record có đủ thông tin để debug mà không cần hỏi thêm.

```
❌ Obs 1.0 — 3 luồng riêng lẻ:
   console.log("user 99 placed order")        ← log
   orderCounter.inc()                          ← metric
   tracer.startSpan("POST /orders")            ← trace

✅ Obs 2.0 — 1 wide event:
   span.setAttributes({
     "user.id": "99", "order.id": "ord-123",
     "order.total": 250000, "db.duration_ms": 12,
     "cache.hit": true, "feature.flag": "new-checkout"
   })
```

**2. SDK làm gì tự động (bạn không cần code)**

- Inject/extract `traceparent` header khi gọi HTTP giữa services
- Tạo child span tự động khi nhận request
- Ghi `http.method`, `http.status_code`, `url.path`, `duration_ms`
- Ghi `db.statement`, `db.system` khi query database
- Link frontend trace với backend trace qua `trace_id`

**3. Chỉ cần thêm business context**

SDK không biết `user.id` hay `order.id` là gì — phải tự thêm vào span. Đây là phần duy nhất cần code thủ công.

---

## Chọn ngôn ngữ 

- [Node.js (Express / Fastify / NestJS)](#nodejs)
- [Python (FastAPI / Django / Flask)](#python)
- [Go (Gin / Echo / chi)](#go)
- [Quy tắc chung cho mọi ngôn ngữ](#quy-tắc-chung)

---

## Node.js

### Bước 1 — Cài package

```bash
npm install \
  @opentelemetry/sdk-node \
  @opentelemetry/auto-instrumentations-node \
  @opentelemetry/exporter-trace-otlp-http \
  @opentelemetry/api
```

### Bước 2 — Tạo file instrumentation (1 lần duy nhất)

Tạo `src/instrumentation.ts` — file này phải được load **trước tất cả** file khác:

```typescript
// src/instrumentation.ts
import { NodeSDK } from '@opentelemetry/sdk-node'
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node'
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http'
import { Resource } from '@opentelemetry/resources'
import {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
} from '@opentelemetry/semantic-conventions'

const sdk = new NodeSDK({
  resource: new Resource({
    [ATTR_SERVICE_NAME]:    process.env.SERVICE_NAME    || 'unknown-service',
    [ATTR_SERVICE_VERSION]: process.env.APP_VERSION     || '0.0.0',
    'deployment.environment': process.env.NODE_ENV      || 'development',
    'team.name':              process.env.TEAM_NAME     || 'unknown',
    'git.commit':             process.env.GIT_COMMIT    || 'local',
  }),
  traceExporter: new OTLPTraceExporter({
    url: process.env.OTEL_EXPORTER_OTLP_ENDPOINT
      || 'http://otel-collector:4318/v1/traces',
  }),
  instrumentations: [
    getNodeAutoInstrumentations({
      '@opentelemetry/instrumentation-fs':  { enabled: false }, // quá noisy
      '@opentelemetry/instrumentation-dns': { enabled: false },
    }),
  ],
})

sdk.start()
process.on('SIGTERM', () => sdk.shutdown())
process.on('SIGINT',  () => sdk.shutdown())
```

Cập nhật `package.json`:

```json
{
  "scripts": {
    "start": "node --require ./dist/instrumentation.js dist/index.js",
    "dev":   "ts-node --require ./src/instrumentation.ts src/index.ts"
  }
}
```

### Bước 3 — Thêm business context vào HTTP endpoint

```typescript
// src/routes/order.ts
import { trace, SpanStatusCode } from '@opentelemetry/api'

router.post('/orders', async (req, res) => {
  const span = trace.getActiveSpan()

  // Thêm context ngay đầu handler — trước khi làm bất cứ việc gì
  span?.setAttributes({
    'user.id':          req.user.id,
    'user.plan':        req.user.plan,
    'order.total':      req.body.total,
    'order.item_count': req.body.items.length,
    'payment.method':   req.body.paymentMethod,
  })

  try {
    const order = await orderService.create(req.body, req.user)

    // Thêm kết quả sau khi xử lý xong
    span?.setAttributes({
      'order.id':         order.id,
      'order.status':     order.status,
      'db.rows_affected': 1,
    })

    res.json(order)
  } catch (err) {
    span?.recordException(err as Error)
    span?.setStatus({ code: SpanStatusCode.ERROR, message: (err as Error).message })
    span?.setAttributes({
      'error.type': (err as Error).constructor.name,
      'error.code': (err as any).code,
    })
    throw err
  }
})
```

### Bước 4 — Worker / Background Job (BullMQ)

```typescript
// src/workers/email.worker.ts
import { trace, context, propagation, SpanStatusCode } from '@opentelemetry/api'

const tracer = trace.getTracer('email-worker')

worker.process('send-email', async (job) => {
  // Khôi phục trace context từ job data (nếu được push từ HTTP request)
  const parentCtx = job.data._otelCtx
    ? propagation.extract(context.active(), job.data._otelCtx)
    : context.active()

  const span = tracer.startSpan(`job.${job.name}`, {}, parentCtx)

  return context.with(trace.setSpan(context.active(), span), async () => {
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
      span.end() // bắt buộc với worker — HTTP tự end, job thì không
    }
  })
})

// Khi push job từ HTTP handler — truyền trace context sang worker
export function pushEmailJob(userId: string, email: string) {
  const otelCtx: Record<string, string> = {}
  propagation.inject(context.active(), otelCtx) // lưu traceparent

  emailQueue.add('send-email', {
    userId,
    email,
    _otelCtx: otelCtx, // worker sẽ đọc cái này
  })
}
```

### Biến môi trường cần set trong K8s

```yaml
# k8s/deployment.yaml
env:
  - name: SERVICE_NAME
    value: "order-service"
  - name: TEAM_NAME
    value: "commerce"
  - name: APP_VERSION
    valueFrom:
      fieldRef:
        fieldPath: metadata.labels['app.kubernetes.io/version']
  - name: GIT_COMMIT
    value: "abc123def"   # inject lúc build CI/CD
  - name: OTEL_EXPORTER_OTLP_ENDPOINT
    value: "http://otel-collector.observability.svc.cluster.local:4318/v1/traces"
```

---

## Python

### Bước 1 — Cài package

```bash
pip install \
  opentelemetry-sdk \
  opentelemetry-exporter-otlp-proto-http \
  opentelemetry-instrumentation-fastapi \
  opentelemetry-instrumentation-django \
  opentelemetry-instrumentation-flask \
  opentelemetry-instrumentation-httpx \
  opentelemetry-instrumentation-requests \
  opentelemetry-instrumentation-sqlalchemy \
  opentelemetry-instrumentation-redis \
  opentelemetry-instrumentation-celery
```

### Bước 2 — Tạo file instrumentation

```python
# app/instrumentation.py
import os
from opentelemetry import trace
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
from opentelemetry.sdk.resources import Resource, SERVICE_NAME, SERVICE_VERSION

def setup_otel() -> None:
    resource = Resource.create({
        SERVICE_NAME:             os.getenv("SERVICE_NAME", "unknown-service"),
        SERVICE_VERSION:          os.getenv("APP_VERSION", "0.0.0"),
        "deployment.environment": os.getenv("ENV", "development"),
        "team.name":              os.getenv("TEAM_NAME", "unknown"),
        "git.commit":             os.getenv("GIT_COMMIT", "local"),
    })

    provider = TracerProvider(resource=resource)
    provider.add_span_processor(
        BatchSpanProcessor(
            OTLPSpanExporter(
                endpoint=os.getenv(
                    "OTEL_EXPORTER_OTLP_ENDPOINT",
                    "http://otel-collector:4318/v1/traces",
                )
            )
        )
    )
    trace.set_tracer_provider(provider)
```

**FastAPI:**

```python
# main.py — setup_otel() PHẢI chạy trước khi import framework
from app.instrumentation import setup_otel
setup_otel()

from fastapi import FastAPI
from opentelemetry.instrumentation.fastapi import FastAPIInstrumentor
from opentelemetry.instrumentation.httpx import HTTPXClientInstrumentor
from opentelemetry.instrumentation.sqlalchemy import SQLAlchemyInstrumentor

app = FastAPI()
FastAPIInstrumentor.instrument_app(app)
HTTPXClientInstrumentor().instrument()
SQLAlchemyInstrumentor().instrument()
```

**Django:**

```python
# manage.py hoặc wsgi.py — trước django.setup()
from app.instrumentation import setup_otel
setup_otel()

import django
django.setup()

from opentelemetry.instrumentation.django import DjangoInstrumentor
from opentelemetry.instrumentation.requests import RequestsInstrumentor
DjangoInstrumentor().instrument()
RequestsInstrumentor().instrument()
```

### Bước 3 — Thêm business context

```python
# app/routers/order.py
from opentelemetry import trace
from opentelemetry.trace import Status, StatusCode

@router.post("/orders")
async def create_order(
    body: OrderRequest,
    current_user: User = Depends(get_current_user),
):
    span = trace.get_current_span()

    span.set_attributes({
        "user.id":          str(current_user.id),
        "user.plan":        current_user.plan,
        "order.total":      float(body.total),
        "order.item_count": len(body.items),
        "payment.method":   body.payment_method,
    })

    try:
        order = await order_service.create(body, current_user)

        span.set_attributes({
            "order.id":         str(order.id),
            "order.status":     order.status,
            "db.rows_affected": 1,
        })
        return order

    except PaymentError as e:
        span.record_exception(e)
        span.set_status(Status(StatusCode.ERROR, str(e)))
        span.set_attributes({
            "error.type":         "PaymentError",
            "error.payment_code": e.code,
        })
        raise
```

### Bước 4 — Celery Worker

```python
# app/tasks/email.py
from celery import Celery
from opentelemetry import trace, propagate, context as otel_ctx
from opentelemetry.instrumentation.celery import CeleryInstrumentor

celery_app = Celery("tasks")
CeleryInstrumentor().instrument()  # gọi 1 lần khi khởi động worker

@celery_app.task(bind=True, max_retries=3, name="tasks.send_email")
def send_email(self, user_id: str, email: str, _otel_ctx: dict = None):
    tracer = trace.get_tracer(__name__)
    parent_ctx = propagate.extract(_otel_ctx) if _otel_ctx else otel_ctx.get_current()

    with tracer.start_as_current_span(f"job.{self.name}", context=parent_ctx) as span:
        span.set_attributes({
            "job.id":        self.request.id or "",
            "job.name":      self.name,
            "job.attempt":   self.request.retries,
            "job.max_retry": self.max_retries,
            "user.id":       user_id,
            "user.email":    email,
        })

        try:
            _do_send_email(user_id, email)
            span.set_attribute("job.outcome", "success")
        except Exception as exc:
            span.set_attribute("job.outcome", "failed")
            span.record_exception(exc)
            raise self.retry(exc=exc, countdown=60)


# Dispatch từ HTTP handler — truyền trace context
def dispatch_email(user_id: str, email: str) -> None:
    otel_context: dict = {}
    propagate.inject(otel_context)  # lưu traceparent
    send_email.delay(user_id, email, _otel_ctx=otel_context)
```

---

## Go

### Bước 1 — Cài package

```bash
go get \
  go.opentelemetry.io/otel \
  go.opentelemetry.io/otel/sdk/trace \
  go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracehttp \
  go.opentelemetry.io/contrib/instrumentation/github.com/gin-gonic/gin/otelgin \
  go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp
```

### Bước 2 — Khởi tạo provider

```go
// internal/telemetry/setup.go
package telemetry

import (
    "context"
    "os"

    "go.opentelemetry.io/otel"
    "go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracehttp"
    "go.opentelemetry.io/otel/sdk/resource"
    sdktrace "go.opentelemetry.io/otel/sdk/trace"
    semconv "go.opentelemetry.io/otel/semconv/v1.21.0"
)

func Setup(ctx context.Context) (shutdown func(), err error) {
    endpoint := getEnv("OTEL_EXPORTER_OTLP_ENDPOINT", "http://otel-collector:4318")

    exporter, err := otlptracehttp.New(ctx,
        otlptracehttp.WithEndpoint(endpoint),
        otlptracehttp.WithInsecure(),
    )
    if err != nil {
        return nil, err
    }

    res := resource.NewWithAttributes(
        semconv.SchemaURL,
        semconv.ServiceName(getEnv("SERVICE_NAME", "unknown-service")),
        semconv.ServiceVersion(getEnv("APP_VERSION", "0.0.0")),
        semconv.DeploymentEnvironment(getEnv("ENV", "development")),
    )

    tp := sdktrace.NewTracerProvider(
        sdktrace.WithBatcher(exporter),
        sdktrace.WithResource(res),
        sdktrace.WithSampler(sdktrace.AlwaysSample()),
    )
    otel.SetTracerProvider(tp)

    return func() { tp.Shutdown(context.Background()) }, nil
}

func getEnv(key, fallback string) string {
    if v := os.Getenv(key); v != "" {
        return v
    }
    return fallback
}
```

```go
// main.go
func main() {
    ctx := context.Background()
    shutdown, err := telemetry.Setup(ctx)
    if err != nil {
        log.Fatal(err)
    }
    defer shutdown()

    r := gin.New()
    r.Use(otelgin.Middleware("order-service")) // tự tạo span cho mọi request
    // ... routes
}
```

### Bước 3 — Thêm business context

```go
// internal/handler/order.go
import (
    "go.opentelemetry.io/otel/attribute"
    "go.opentelemetry.io/otel/codes"
    "go.opentelemetry.io/otel/trace"
)

func (h *OrderHandler) CreateOrder(c *gin.Context) {
    span := trace.SpanFromContext(c.Request.Context())

    var body CreateOrderRequest
    c.ShouldBindJSON(&body)

    user := c.MustGet("user").(*User)

    span.SetAttributes(
        attribute.String("user.id",        user.ID),
        attribute.String("user.plan",      user.Plan),
        attribute.Float64("order.total",   body.Total),
        attribute.Int("order.item_count",  len(body.Items)),
        attribute.String("payment.method", body.PaymentMethod),
    )

    order, err := h.orderService.Create(c.Request.Context(), body, user)
    if err != nil {
        span.RecordError(err)
        span.SetStatus(codes.Error, err.Error())
        span.SetAttributes(attribute.String("error.type", fmt.Sprintf("%T", err)))
        c.JSON(500, gin.H{"error": err.Error()})
        return
    }

    span.SetAttributes(
        attribute.String("order.id",     order.ID),
        attribute.String("order.status", order.Status),
    )
    c.JSON(201, order)
}
```

### Bước 4 — Worker (goroutine)

```go
// internal/worker/email.go
var tracer = otel.Tracer("email-worker")

type EmailJob struct {
    UserID   string
    Email    string
    TraceCtx map[string]string // nhận từ producer
}

func ProcessEmailJob(job EmailJob) error {
    // Khôi phục trace context từ producer
    carrier := propagation.MapCarrier(job.TraceCtx)
    ctx := otel.GetTextMapPropagator().Extract(context.Background(), carrier)

    ctx, span := tracer.Start(ctx, "job.send_email")
    defer span.End() // bắt buộc với worker

    span.SetAttributes(
        attribute.String("job.name",   "send_email"),
        attribute.String("user.id",    job.UserID),
        attribute.String("user.email", job.Email),
    )

    if err := sendEmail(ctx, job.UserID, job.Email); err != nil {
        span.RecordError(err)
        span.SetAttributes(attribute.String("job.outcome", "failed"))
        return err
    }

    span.SetAttributes(attribute.String("job.outcome", "success"))
    return nil
}

// Dispatch từ HTTP handler
func DispatchEmailJob(ctx context.Context, userID, email string) {
    carrier := make(propagation.MapCarrier)
    otel.GetTextMapPropagator().Inject(ctx, carrier)

    jobQueue <- EmailJob{UserID: userID, Email: email, TraceCtx: map[string]string(carrier)}
}
```

---

## Quy tắc chung

### Đặt tên attribute

| Nhóm | Format | Ví dụ |
|---|---|---|
| User | `user.*` | `user.id`, `user.email`, `user.plan` |
| Domain entity | `<entity>.*` | `order.id`, `order.total`, `product.id` |
| Job | `job.*` | `job.id`, `job.queue`, `job.attempt`, `job.outcome` |
| Feature flag | `feature.*` | `feature.flag`, `feature.variant` |
| Lỗi | `error.*` | `error.type`, `error.code` |
| HTTP | `http.*` | SDK tự điền — không cần làm gì |
| Database | `db.*` | SDK tự điền — không cần làm gì |

**Dùng dấu chấm, chữ thường:**
```
✅  user.id       order.total      job.outcome
❌  userId        orderTotal       jobOutcome
❌  user_id       order_total      job_outcome
```

### Những việc KHÔNG làm

```
❌  Emit Prometheus counter/gauge thủ công
    → metrics được tự động derive từ spans qua Materialized View

❌  console.log / print để debug production
    → thêm attribute vào span, xem bằng HyperDX

❌  Tự generate trace_id hoặc span_id
    → SDK tự làm

❌  Tạo span mới chỉ để thêm thông tin
    → dùng span.setAttribute() trên span hiện tại

❌  Thêm traceparent header thủ công khi gọi HTTP giữa services
    → SDK tự inject/extract
```

---

## Kiểm tra sau khi setup

```bash
# Xem span đã vào ClickHouse chưa
clickhouse-client --query "
  SELECT service_name, count() as spans, avg(duration_ns)/1e6 as avg_ms
  FROM otel_traces
  WHERE timestamp > now() - INTERVAL 5 MINUTE
  GROUP BY service_name
"
```

Hoặc mở HyperDX → Search → gõ tên service → thấy span là OK.

---

## Checklist trước khi merge PR

- [ ] Service đã có file `instrumentation` và được load trước mọi file khác
- [ ] Biến môi trường `SERVICE_NAME`, `TEAM_NAME`, `APP_VERSION` đã set trong K8s manifest
- [ ] Mỗi HTTP endpoint thêm ít nhất: `user.id` + entity ID liên quan
- [ ] Worker thêm ít nhất: `job.id`, `job.queue`, `job.attempt`, `job.outcome`, `user.id`
- [ ] Worker gọi `span.end()` trong `finally` block
- [ ] Worker nhận và restore `_otelCtx` từ job data khi được dispatch từ HTTP request
- [ ] Không có Prometheus metric emit thủ công trong code mới
- [ ] Chạy local, xác nhận span xuất hiện trong HyperDX dev environment với đủ attribute

---

*Tài liệu kiến trúc tổng thể: `docs/observability-architecture.md`*
*Semantic Conventions (tên attribute chuẩn): https://opentelemetry.io/docs/specs/semconv/*
*Slack: `#observability`*
