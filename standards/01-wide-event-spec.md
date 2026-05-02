# Wide Event Standard — Chuẩn chung cho toàn bộ team

> **Version:** 1.0  
> **Status:** Draft

---

## Tại sao cần chuẩn này

Không có chuẩn thống nhất, mỗi team đặt tên attribute theo cách riêng:

```
Team A: user_id = "99"
Team B: userId = "99"  
Team C: uid = "99"
Team D: customer_id = "99"
```

Hệ quả: không thể query cross-service, không thể build dashboard chung, mỗi incident phải đọc code mới biết field tên gì.

Với spec này: mọi service dùng `user.id` — một câu query là thấy toàn bộ hành trình của user qua tất cả services.

---

## Cấu trúc wide event

Một wide event hợp lệ gồm 4 nhóm field, xếp theo thứ tự ưu tiên:

```
┌─────────────────────────────────────────────────────────┐
│  1. REQUIRED — mọi span đều phải có                     │
│     service.name, trace_id, span_id, duration_ms         │
├─────────────────────────────────────────────────────────┤
│  2. CONTEXT — SDK tự điền (không cần code)              │
│     http.method, http.status_code, db.statement, ...     │
├─────────────────────────────────────────────────────────┤
│  3. BUSINESS — dev phải thêm thủ công                   │
│     user.id, <entity>.id, error.type, feature.flag       │
├─────────────────────────────────────────────────────────┤
│  4. DOMAIN-SPECIFIC — từng team tự định nghĩa           │
│     order.total, payment.method, loan.amount, ...        │
└─────────────────────────────────────────────────────────┘
```

---

## Nhóm 1 — Required (SDK tự điền, không cần code)

Những field này tự động có sau khi setup OTel SDK. Liệt kê ở đây để mọi người biết chúng tồn tại.

| Attribute | Type | Ví dụ | Mô tả |
|---|---|---|---|
| `service.name` | string | `"order-service"` | Set qua env `SERVICE_NAME` |
| `service.version` | string | `"2.4.1"` | Set qua env `APP_VERSION` |
| `deployment.environment` | string | `"production"` | Set qua env `ENV` |
| `team.name` | string | `"commerce"` | Set qua env `TEAM_NAME` |
| `git.commit` | string | `"abc123def"` | Set qua env `GIT_COMMIT` |
| `trace_id` | string | `"4bf92f35..."` | SDK tự generate |
| `span_id` | string | `"00f067aa..."` | SDK tự generate |
| `parent_span_id` | string | `"b9c7c989..."` | SDK tự set từ traceparent header |
| `duration_ms` | float | `145.3` | SDK tự tính |
| `timestamp` | datetime | `2025-05-02T10:23:45Z` | SDK tự set |

**Cách đảm bảo:** Set đủ biến môi trường trong K8s deployment manifest. Xem `docs/otel-setup-guide.md`.

---

## Nhóm 2 — Context (SDK tự điền theo loại operation)

### HTTP Server span (inbound request)

SDK tự điền khi nhận HTTP request. Dev không cần làm gì.

| Attribute | Type | Ví dụ |
|---|---|---|
| `http.request.method` | string | `"POST"` |
| `http.response.status_code` | int | `200` |
| `url.path` | string | `"/api/orders"` |
| `url.scheme` | string | `"https"` |
| `server.address` | string | `"api.example.com"` |
| `client.address` | string | `"192.168.1.1"` |
| `user_agent.original` | string | `"Mozilla/5.0..."` |

### HTTP Client span (gọi service khác)

SDK tự điền khi service gọi ra ngoài qua HTTP.

| Attribute | Type | Ví dụ |
|---|---|---|
| `http.request.method` | string | `"GET"` |
| `http.response.status_code` | int | `200` |
| `server.address` | string | `"payment-service"` |
| `url.full` | string | `"http://payment-service/charge"` |

### Database span

SDK tự điền khi query DB (PostgreSQL, MySQL, MongoDB, Redis).

| Attribute | Type | Ví dụ |
|---|---|---|
| `db.system` | string | `"postgresql"` |
| `db.name` | string | `"orders_db"` |
| `db.operation.name` | string | `"SELECT"` |
| `db.query.text` | string | `"SELECT * FROM orders WHERE..."` |
| `server.address` | string | `"postgres.internal"` |

> ⚠️ **Lưu ý bảo mật:** `db.query.text` có thể chứa data nhạy cảm. Cấu hình OTel Collector để sanitize nếu cần.

---

## Nhóm 3 — Business context (dev phải thêm thủ công)

**Đây là phần quan trọng nhất.** SDK không biết `user.id` là gì — dev phải tự thêm.

### 3.1 User context

Thêm vào **mọi** span có liên quan đến một user cụ thể.

| Attribute | Type | Required | Ví dụ | Ghi chú |
|---|---|---|---|---|
| `user.id` | string | **Bắt buộc** | `"usr_99"` | ID nội bộ của hệ thống |
| `user.plan` | string | Nên có | `"premium"` | `free` / `basic` / `premium` / `enterprise` |
| `user.type` | string | Nên có | `"human"` | `human` / `bot` / `service_account` |

```typescript
// ✅ Đúng
span.setAttributes({
  'user.id':   currentUser.id,    // string, không phải number
  'user.plan': currentUser.plan,
})

// ❌ Sai — không dùng PII trực tiếp
span.setAttributes({
  'user.email':    currentUser.email,    // PII — không đưa vào span
  'user.password': '...',                // tuyệt đối không
})
```

> **PII Policy:** Không đưa email, phone, họ tên, địa chỉ vào span attribute. Chỉ dùng internal ID. Nếu cần debug theo email, dùng HyperDX để lookup từ `user.id`.

### 3.2 Request outcome

Thêm vào cuối mỗi handler — sau khi biết kết quả.

| Attribute | Type | Required | Ví dụ |
|---|---|---|---|
| `request.outcome` | string | **Bắt buộc** | `"success"` / `"error"` / `"partial"` |

### 3.3 Error context

Thêm khi có lỗi xảy ra. SDK tự ghi `exception.message` và `exception.stacktrace` — chỉ cần thêm context business.

| Attribute | Type | Required | Ví dụ |
|---|---|---|---|
| `error.type` | string | **Bắt buộc khi có lỗi** | `"PaymentDeclined"` |
| `error.code` | string | Nên có | `"INSUFFICIENT_FUNDS"` |
| `error.is_retryable` | bool | Nên có | `true` |

```typescript
// ✅ Đúng — thêm context, không chỉ ghi exception
} catch (err) {
  span.recordException(err)             // SDK tự ghi stack trace
  span.setStatus({ code: SpanStatusCode.ERROR })
  span.setAttributes({
    'error.type':        err.constructor.name,   // loại lỗi
    'error.code':        err.code,               // mã lỗi business
    'error.is_retryable': err.isRetryable ?? false,
    'request.outcome':   'error',
  })
}
```

### 3.4 Feature flag

Thêm khi request đi qua một feature flag — giúp debug rollout issue.

| Attribute | Type | Ví dụ |
|---|---|---|
| `feature.flag` | string | `"new-checkout-v2"` |
| `feature.variant` | string | `"treatment"` / `"control"` |

### 3.5 Job / Worker context

Bắt buộc cho mọi background job và worker.

| Attribute | Type | Required | Ví dụ |
|---|---|---|---|
| `job.id` | string | **Bắt buộc** | `"job_abc123"` |
| `job.name` | string | **Bắt buộc** | `"send-email"` |
| `job.queue` | string | **Bắt buộc** | `"email-queue"` |
| `job.attempt` | int | **Bắt buộc** | `1` |
| `job.max_retry` | int | Nên có | `3` |
| `job.outcome` | string | **Bắt buộc** | `"success"` / `"failed"` / `"skipped"` |
| `job.payload_size` | int | Nên có | `1024` (bytes) |

---

## Nhóm 4 — Domain-specific (từng team tự định nghĩa)

Mỗi team tự định nghĩa attribute cho domain của mình, tuân theo quy tắc đặt tên chung.

### Template để định nghĩa domain attribute

```
namespace: <domain>
attributes:
  - name: <domain>.<field>
    type: string | int | float | bool
    required: true | false
    example: "..."
    description: "..."
```

### Ví dụ — E-commerce domain

```yaml
namespace: order
attributes:
  - name: order.id
    type: string
    required: true
    example: "ord_abc123"

  - name: order.total
    type: float
    required: true
    example: 250000.0
    description: "Đơn vị VND"

  - name: order.item_count
    type: int
    required: false
    example: 3

  - name: order.status
    type: string
    required: false
    example: "pending | confirmed | shipped | delivered | cancelled"

namespace: payment
attributes:
  - name: payment.method
    type: string
    required: true
    example: "credit_card | momo | vnpay | cod"

  - name: payment.provider
    type: string
    required: false
    example: "stripe | vnpay"

  - name: payment.status
    type: string
    required: true
    example: "success | failed | pending"
```

> **Hướng dẫn:** Copy template trên, điền vào file `docs/wide-event-domain-<team>.md` trong repo của team, rồi gửi link vào `#observability` để được review.

---

## Quy tắc đặt tên (bắt buộc tuân theo)

### Format

```
<namespace>.<field_name>
```

- Namespace và field đều viết **chữ thường**
- Dùng **dấu chấm** phân cách namespace
- Field name dùng **dấu gạch dưới** nếu có nhiều từ

```
✅  user.id
✅  order.item_count
✅  payment.method
✅  job.max_retry
✅  error.is_retryable

❌  userId           (thiếu namespace)
❌  user_id          (dùng gạch dưới thay dấu chấm)
❌  User.ID          (viết hoa)
❌  ORDER.total      (namespace viết hoa)
❌  user.firstName   (camelCase)
```

### Kiểu dữ liệu

| Kiểu | Dùng khi | Ví dụ |
|---|---|---|
| `string` | ID, tên, status, enum | `"ord_123"`, `"success"` |
| `int` | Đếm, số nguyên | `item_count: 3`, `attempt: 1` |
| `float` | Tiền, tỉ lệ, thời gian | `total: 250000.0`, `rate: 0.95` |
| `bool` | Cờ nhị phân | `cache_hit: true`, `is_retryable: false` |

**ID luôn là string:**
```
✅  'user.id': "99"       (string)
❌  'user.id': 99         (number — gây lỗi khi query high-cardinality)
```

---

## Ví dụ wide event hoàn chỉnh

### HTTP API span

```json
{
  "service.name":            "order-service",
  "service.version":         "2.4.1",
  "deployment.environment":  "production",
  "team.name":               "commerce",
  "git.commit":              "abc123def",

  "trace_id":       "4bf92f3577b34da6a3ce929d0e0e4736",
  "span_id":        "b9c7c989f97918e1",
  "parent_span_id": "00f067aa0ba902b7",
  "duration_ms":    145.3,

  "http.request.method":      "POST",
  "http.response.status_code": 201,
  "url.path":                  "/api/orders",

  "user.id":          "usr_99",
  "user.plan":        "premium",
  "user.type":        "human",

  "order.id":         "ord_abc123",
  "order.total":      250000.0,
  "order.item_count": 3,
  "order.status":     "confirmed",

  "payment.method":   "momo",
  "payment.status":   "success",

  "feature.flag":     "new-checkout-v2",
  "feature.variant":  "treatment",

  "request.outcome":  "success"
}
```

### Worker span

```json
{
  "service.name":   "notification-service",
  "team.name":      "platform",

  "trace_id":       "4bf92f3577b34da6a3ce929d0e0e4736",
  "span_id":        "c4ca4238a0b92382",
  "duration_ms":    890.0,

  "job.id":           "job_xyz789",
  "job.name":         "send-order-email",
  "job.queue":        "email-queue",
  "job.attempt":      1,
  "job.max_retry":    3,
  "job.payload_size": 512,
  "job.outcome":      "success",

  "user.id":          "usr_99",
  "order.id":         "ord_abc123"
}
```

### Error span

```json
{
  "service.name": "payment-service",
  "team.name":    "fintech",

  "trace_id":  "4bf92f3577b34da6a3ce929d0e0e4736",
  "span_id":   "d41d8cd98f00b204",
  "duration_ms": 2340.0,

  "http.request.method":       "POST",
  "http.response.status_code": 402,
  "url.path":                  "/api/charge",

  "user.id":      "usr_99",
  "user.plan":    "basic",

  "payment.method":   "credit_card",
  "payment.provider": "stripe",
  "payment.status":   "failed",

  "error.type":        "PaymentDeclined",
  "error.code":        "INSUFFICIENT_FUNDS",
  "error.is_retryable": false,

  "request.outcome": "error"
}
```

---

## Validation — tự kiểm tra span của mình

Sau khi implement, chạy query sau trên ClickHouse để kiểm tra span của service đã đủ chuẩn chưa:

```sql
-- Kiểm tra các attribute bắt buộc có đủ không
SELECT
    service_name,
    count()                                                    AS total_spans,
    countIf(SpanAttributes['user.id'] != '')                   AS has_user_id,
    countIf(SpanAttributes['request.outcome'] != '')           AS has_outcome,
    countIf(SpanAttributes['team.name'] != '')                 AS has_team,
    round(countIf(SpanAttributes['user.id'] != '') * 100.0
          / count(), 1)                                        AS user_id_coverage_pct
FROM otel_traces
WHERE ServiceName = 'your-service-name'
  AND Timestamp > now() - INTERVAL 1 HOUR
  AND SpanKind = 'SPAN_KIND_SERVER'  -- chỉ kiểm tra inbound HTTP
GROUP BY service_name
```

**Kết quả kỳ vọng:**

| Metric | Target |
|---|---|
| `user_id_coverage_pct` | > 90% (trừ public/anonymous endpoints) |
| `has_outcome` | 100% |
| `has_team` | 100% |

---

## Lộ trình áp dụng

| Giai đoạn | Nội dung |
|---|---|
| **Phase 1** | Setup SDK, emit span cơ bản. Kiểm tra span xuất hiện trong ClickHouse. |
| **Phase 2** | Thêm business context (user.id, entity ID, outcome). Chạy validation query. |
| **Phase 3** | Định nghĩa domain-specific attributes cho từng team. Review chéo. |
| **Phase 4** | Enforce qua CI — PR fail nếu service thiếu required attributes. |


---

*Tài liệu liên quan:*  
*- `docs/otel-setup-guide.md` — hướng dẫn setup SDK cho từng ngôn ngữ*  
*- `docs/observability-architecture.md` — kiến trúc tổng thể*  
*- OTel Semantic Conventions: https://opentelemetry.io/docs/specs/semconv/*
