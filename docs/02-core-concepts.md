# Khái niệm cốt lõi

> Giải thích **Span**, **Trace**, **Wide Event** là gì — và chúng liên quan với nhau thế nào.  
> Đọc xong tài liệu này, bạn sẽ hiểu tại sao `trace_id` là "sợi chỉ đỏ" kết nối toàn bộ hệ thống.

---

## Span — đơn vị cơ bản

**Span** là một record đại diện cho một đơn vị công việc trong hệ thống. Ví dụ:

- Một HTTP request đến API
- Một câu SQL query
- Một job trong queue được xử lý
- Một call đến external service

Mỗi span có:

```
span_id        : ID duy nhất của span này
parent_span_id : ID của span gọi span này (nếu có)
trace_id       : ID của toàn bộ "hành trình" request
service_name   : service nào tạo ra span này
name           : tên operation (ví dụ: "POST /orders")
start_time     : lúc bắt đầu
end_time       : lúc kết thúc
duration_ms    : thời gian xử lý
status         : ok / error
attributes     : mọi thông tin bổ sung (key-value)
```

---

## Wide Event — span được làm giàu

**Wide event** là một span được **thêm rất nhiều business context** vào phần `attributes`:

```
Span thông thường:          Wide event:
─────────────────           ─────────────────────────────────────────
trace_id: abc               trace_id: abc
span_id: s1                 span_id: s1
service: order-svc          service: order-svc
duration_ms: 145            duration_ms: 145
http.status: 200            http.status: 200
                            user.id: "usr_99"          ← thêm
                            user.plan: "premium"        ← thêm
                            order.id: "ord_456"         ← thêm
                            order.total: 250000         ← thêm
                            db.query: "INSERT..."       ← thêm
                            cache.hit: true             ← thêm
                            feature.flag: "new-v2"      ← thêm
```

Sự khác biệt không phải về kỹ thuật — mà về **triết lý**: thay vì log từng dòng riêng lẻ, bạn gom toàn bộ context của một request vào một record duy nhất.

---

## Trace — hành trình của một request

**Trace** là tập hợp tất cả spans thuộc về **cùng một request gốc**, liên kết với nhau qua `trace_id`.

Ví dụ: user bấm "Đặt hàng" tạo ra một trace với 5 spans:

```
trace_id = "abc-123"
│
├── span s1: API Gateway          (200ms) ← root span, parent_span_id = null
│   ├── span s2: Order Service    (145ms) ← parent_span_id = s1
│   │   ├── span s3: DB query     (12ms)  ← parent_span_id = s2
│   │   └── span s4: Redis cache  (3ms)   ← parent_span_id = s2
│   └── span s5: Payment Service  (80ms)  ← parent_span_id = s1
```

Tất cả 5 spans đều có `trace_id = "abc-123"`. Khi query ClickHouse:

```sql
SELECT * FROM otel_traces
WHERE trace_id = 'abc-123'
ORDER BY timestamp
```

Bạn thấy toàn bộ hành trình của request đó — không cần nhảy qua lại giữa các tool.

---

## Mỗi thành phần tạo wide event riêng

Một điều hay gây nhầm: **mỗi service tạo wide event riêng của mình**, không nhét chung vào một record.

```
User bấm "Đặt hàng"
    │
    ▼
[Frontend]   → wide event: { session_id, click, LCP, trace_id }
    │
    ▼ HTTP request với traceparent header
[API Gateway] → wide event: { trace_id, user.id, path, duration }
    │
    ▼ gọi nội bộ
[Order API]  → wide event: { trace_id, order.id, total, db.query }
    │
    ├─▶ [DB call]     → wide event: { trace_id, db.statement, rows }
    └─▶ [Redis call]  → wide event: { trace_id, cache.hit, key }
    │
    ▼ push queue
[Worker]     → wide event: { trace_id (linked), job.id, outcome }
```

Tất cả vào cùng bảng `otel_traces` trong ClickHouse.  
Liên kết qua `trace_id` và `parent_span_id`.

---

## traceparent header — sợi chỉ liên kết

Khi API này gọi API khác, làm sao `trace_id` được truyền sang? Qua HTTP header `traceparent`.

```
API 1 gọi API 2:
─────────────────────────────────────────────────────────
HTTP Request:
  POST /orders
  traceparent: 00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01
               ^^  ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^  ^^^^^^^^^^^^^^^^  ^^
               ver        trace_id (128-bit)          span_id (64-bit)  flags
─────────────────────────────────────────────────────────
```

**OTel SDK làm việc này tự động** — bạn không cần viết code. SDK hook vào HTTP client library (fetch, axios, requests, http.Get...) và tự inject/extract header này.

---

## 3 loại quan hệ giữa spans

### 1. Parent-child (đồng bộ)
API 1 gọi API 2 và đợi kết quả.

```
API 1 (s1) ──────────────────────────────────────
           └── API 2 (s2, parent=s1) ────────────
               └── DB (s3, parent=s2) ───────────
```

### 2. Fan-out song song
API 1 gọi nhiều service cùng lúc (Promise.all, goroutine).

```
API 1 (s1) ──────────────────────────────────────
           ├── Product API (s2, parent=s1) ───────
           ├── Inventory (s3, parent=s1) ──────────
           └── Price API (s4, parent=s1) ──────────
```

Duration của s1 = span chậm nhất trong 3 child.

### 3. Async qua queue
API push job vào queue, Worker xử lý sau — hai trace riêng, liên kết qua `span.links`.

```
Trace ABC:                          Trace XYZ (async):
API (s1) → Queue push (s2)    ~~→   Worker (links=[trace_id=ABC])
```

---

## Async context — tại sao trace_id không bị mất khi có await/goroutine

Đây là câu hỏi hay gặp: nếu code dùng `async/await` hay goroutine, làm sao `trace_id` không bị mất?

Câu trả lời là **AsyncLocalStorage** (Node.js), **contextvars** (Python), **context.Context** (Go). Đây là cơ chế của ngôn ngữ cho phép truyền data ngầm theo từng execution context mà không cần pass parameter.

```typescript
// Node.js — bạn không thấy nhưng SDK dùng điều này
asyncLocalStorage.run({ traceId: "abc-123" }, async () => {
  await step1()  // thấy traceId
  await step2()  // thấy traceId
  await step3()  // thấy traceId
})
// Mỗi await vẫn giữ nguyên context — không bị mất
```

OTel SDK setup AsyncLocalStorage một lần khi khởi động. Mọi async operation sau đó tự động inherit context mà không cần developer làm gì.

---

## Tóm tắt

| Khái niệm | Là gì | Ví dụ |
|---|---|---|
| **Span** | Đơn vị công việc | Một HTTP request, một DB query |
| **Wide event** | Span + business context | Span với user.id, order.id, cache.hit... |
| **Trace** | Tập hợp spans cùng trace_id | Toàn bộ hành trình của "Đặt hàng" |
| **traceparent** | HTTP header truyền trace_id | SDK tự inject/extract |
| **trace_id** | Sợi chỉ liên kết | Dùng để JOIN trong ClickHouse |

---

*Tiếp theo: [`03-request-flow-patterns.md`](03-request-flow-patterns.md) — Các pattern request phổ biến trong microservices*
