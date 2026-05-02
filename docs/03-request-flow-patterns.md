# Các pattern request trong microservices

> Liệt kê 6 pattern phổ biến nhất khi một request đi vào hệ thống.  
> Hiểu các pattern này giúp bạn biết span sẽ trông như thế nào trong ClickHouse.

---

## Pattern 1 — Gọi tuần tự (Chain)

**Mô tả:** API1 gọi API2, API2 gọi API3 — mỗi bước đợi bước trước hoàn thành.

**Ví dụ thực tế:** `Checkout API → Payment API → Fraud Check → Bank API`

```
trace_id = "abc-123"

User ──→ API 1 (s1, root)
              └──→ API 2 (s2, parent=s1)
                        └──→ API 3 (s3, parent=s2)
                                   └──→ DB (s4, parent=s3)
```

**Spans trong ClickHouse:** 4 rows, cùng `trace_id`, liên kết qua `parent_span_id`.

**Lưu ý khi instrument:** traceparent header được truyền tự động. Chỉ cần thêm business context vào từng span.

---

## Pattern 2 — Fan-out song song

**Mô tả:** API1 gọi nhiều API cùng lúc (`Promise.all`, goroutine, threading).

**Ví dụ thực tế:** `Search API → [Product API, Inventory API, Price API]` chạy song song

```
trace_id = "abc-123"

API 1 (s1, root)
├──→ Product API  (s2, parent=s1)  ─────────┐
├──→ Inventory    (s3, parent=s1)  ──────┐   │
└──→ Price API    (s4, parent=s1)  ───┐  │   │
                                      └──┴───┘ kết quả
```

**Điểm quan trọng:** Duration của s1 = span chậm nhất trong 3 child span. Nếu Price API mất 500ms trong khi hai cái kia chỉ mất 50ms, toàn bộ request tốn 500ms.

**Cách debug:** Query ClickHouse group by `parent_span_id` để thấy span nào là bottleneck.

---

## Pattern 3 — Async qua Queue

**Mô tả:** API push message vào queue rồi return ngay. Worker nhận và xử lý sau — không cùng thời gian.

**Ví dụ thực tế:** `Order API → Kafka → Email Worker` (xử lý 5 giây sau)

```
Trace ABC (synchronous):          Trace XYZ (async, sau đó):
API (s1)                           Worker
  └──→ Queue push (s2)    ~~→      span: links = [trace_id=ABC]
       (return ngay)
```

**Điểm quan trọng:** Đây là **2 trace riêng biệt**, không phải parent-child. Liên kết qua `span.links`.

**Cách truyền context:** API ghi `trace_id` vào message header/metadata khi push. Worker đọc ra và tạo trace mới với `links`.

```typescript
// Khi push job — lưu trace context vào job data
const otelCtx = {}
propagation.inject(context.active(), otelCtx)
queue.add('send-email', { userId, _otelCtx: otelCtx })

// Khi worker nhận job — restore context
const parentCtx = propagation.extract(context.active(), job.data._otelCtx)
const span = tracer.startSpan('job.send_email', {}, parentCtx)
```

---

## Pattern 4 — Hỗn hợp thực tế

**Mô tả:** Kết hợp chain + fan-out + async trong cùng một flow. Đây là pattern thực tế của hầu hết hệ thống.

**Ví dụ thực tế:** `Checkout flow`

```
Auth API (s1)
  └──→ Order API (s2)
            ├──→ DB write (s3)       ─┐ fan-out
            ├──→ Redis cache (s4)    ─┤ song song
            └──→ Payment API (s5)   ─┘
                      └──→ Queue push (s6)
                                         ~~→ Email Worker (trace XYZ)
```

**Kết quả:** 6 spans trong 1 trace chính + 1 trace async. Tổng **7 wide events** trong ClickHouse cho 1 user action "Checkout".

---

## Pattern 5 — Gọi external service

**Mô tả:** Gọi API bên thứ 3 (Stripe, SendGrid, Google Maps...) — trace không đi vào bên trong service đó.

**Ví dụ thực tế:** `Payment Service → Stripe API`

```
Payment Service (s1)
  └──→ HTTP client span (s2): stripe.com/charges
       status=200, duration=340ms
       (không có span nào từ bên trong Stripe)
```

**Điểm quan trọng:** Bạn chỉ thấy **client span** từ phía mình — URL, status code, duration của round-trip. Không thể thấy bên trong Stripe làm gì.

**Nên ghi:** `http.url`, `http.status_code`, `duration_ms`. Nếu Stripe trả lỗi, ghi thêm `error.type` và response body (nếu không sensitive).

---

## Pattern 6 — Circular dependency (anti-pattern)

**Mô tả:** Service A gọi B, B gọi ngược lại A. Đây là lỗi thiết kế kiến trúc.

**Ví dụ:** `Auth Service` cần thông tin user → gọi `User Service` → User Service cần xác thực request → gọi lại `Auth Service`

```
Auth (s1) ──→ User (s2) ──→ Auth (s3) ──→ User (s4) ──→ ...
```

**Hệ quả:** Hai service chờ nhau mãi → timeout cascade → toàn bộ request fail.

**Cách phát hiện qua trace:**

```sql
-- Tìm trace có cùng service xuất hiện nhiều hơn 1 lần
SELECT trace_id, service_name, count() as appearances
FROM otel_traces
WHERE timestamp > now() - INTERVAL 1 HOUR
GROUP BY trace_id, service_name
HAVING appearances > 1
ORDER BY appearances DESC
LIMIT 20
```

Trace waterfall trong HyperDX sẽ cho thấy cùng service name xuất hiện nhiều lần ở các depth khác nhau — đây là dấu hiệu rõ ràng nhất.

---

## Tóm tắt các pattern

| Pattern | Trace structure | Số trace | Cách liên kết |
|---|---|---|---|
| Chain | Tree (linear) | 1 | `parent_span_id` |
| Fan-out | Tree (wide) | 1 | `parent_span_id` |
| Async queue | Tách biệt | 2+ | `span.links` |
| Hỗn hợp | Tree + links | 1+ | cả hai |
| External | Leaf node | 1 | n/a |
| Circular | Lặp vô hạn | 1 | **bug** |

---

*Tiếp theo: [`04-migration-strategy.md`](04-migration-strategy.md) — Lộ trình chuyển đổi từng bước*
