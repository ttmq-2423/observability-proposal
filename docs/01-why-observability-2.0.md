# Tại sao cần Observability 2.0

> Tài liệu này giải thích **vấn đề** của cách làm hiện tại và **tại sao** Observability 2.0 là hướng đi đúng.  
> Không có code. Chỉ có tư duy.

---

## Câu chuyện thực tế

3 giờ sáng, PagerDuty reo. Checkout bị lỗi — user không đặt được hàng.

Kỹ sư on-call mở laptop và bắt đầu:

1. Mở Grafana → thấy error rate tăng đột biến lúc 2:47 AM
2. Mở Loki → search log → tìm được dòng `PaymentDeclined` của user X
3. Mở Jaeger → search trace → tìm được trace của user X
4. Trace cho thấy Payment service timeout sau 30s
5. Quay lại Loki tìm log của Payment service... nhưng log format khác, phải học lại query
6. Cuối cùng sau 45 phút: phát hiện DB connection pool của Payment service bị cạn kiệt

**45 phút** chỉ để tìm ra 1 nguyên nhân. Và đó là trường hợp may mắn — kỹ sư quen cả 3 tool.

---

## Vấn đề gốc rễ: Data Silos

Observability 1.0 được xây dựng trên "3 trụ cột" — metrics, logs, traces — mỗi thứ một hệ thống riêng:

```
┌─────────────┐   ┌─────────────┐   ┌─────────────┐
│  Prometheus │   │   Loki/ELK  │   │   Jaeger    │
│  (metrics)  │   │   (logs)    │   │  (traces)   │
└─────────────┘   └─────────────┘   └─────────────┘
      ↑                  ↑                 ↑
   counter.inc()    logger.info()    span.start()
```

Mỗi hệ thống nhìn vào **một góc khác nhau** của cùng một sự kiện. Không có liên kết tự nhiên giữa chúng.

### Hậu quả cụ thể

**1. Khi debug phải nhảy giữa 3 tool**

Biết error rate tăng từ Prometheus, nhưng phải tự đoán đây là lỗi của service nào, rồi sang Loki tìm log, rồi sang Jaeger tìm trace. Ba bước thủ công, dễ miss context.

**2. Metrics bị pre-aggregated — mất detail**

Prometheus lưu aggregated metrics: `http_requests_total{status="500"} = 142`. Bạn biết có 142 lỗi, nhưng không biết user nào bị ảnh hưởng, payload là gì, request đó đi qua những service nào.

**3. Logs không có context**

```
ERROR: Payment failed for user 99
```

User 99 là ai? Request đó có gì đặc biệt? DB query chạy bao lâu? Không biết — log không có.

**4. Cardinality limit của Prometheus**

Prometheus không thể track `user_id` hay `order_id` vì cardinality quá cao. Kết quả: metrics chỉ ở mức aggregate, không thể drill down đến từng user hay transaction.

---

## Observability 2.0 giải quyết thế nào

### Ý tưởng cốt lõi: Wide Event

Thay vì emit 3 luồng riêng lẻ, mỗi request chỉ tạo **1 wide event** — một structured record chứa toàn bộ context của request đó:

```json
{
  "timestamp":    "2025-05-02T10:23:45Z",
  "trace_id":     "4bf92f35...",
  "service":      "order-service",
  "user.id":      "usr_99",
  "user.plan":    "premium",
  "order.id":     "ord_456",
  "order.total":  250000,
  "http.method":  "POST",
  "http.status":  500,
  "duration_ms":  2340,
  "db.query":     "INSERT INTO orders...",
  "db.duration":  1890,
  "error.type":   "DBConnectionTimeout",
  "error.code":   "POOL_EXHAUSTED"
}
```

Từ record này, bạn có thể:
- **Derive metrics**: đếm error rate, tính p99 latency — không cần Prometheus
- **Search như log**: full-text search trên mọi field — không cần Loki
- **Trace**: follow `trace_id` qua nhiều service — không cần Jaeger

**1 record. 3 use case. 0 tool switching.**

### Single source of truth

```
Wide Events → OTel Collector → ClickHouse
                                    ↓
                          otel_traces  (raw events)
                          otel_logs    (infra logs)
                          otel_metrics (derived via Materialized View)
                                    ↓
                    HyperDX (debug)  Grafana (dashboard)
```

Metrics không còn được emit từ application code. Chúng được **tự động tính** từ wide events qua Materialized View của ClickHouse — incremental, không cần re-scan data.

---

## So sánh trực tiếp: cùng 1 incident

### Obs 1.0 — 45 phút

```
1. Grafana: thấy error rate tăng           [2 phút]
2. Loki: tìm log theo thời gian            [8 phút]
3. Loki: đọc log, đoán service nào lỗi    [5 phút]
4. Jaeger: search trace của service đó    [10 phút]
5. Jaeger: trace chỉ có span — không có context  [?]
6. Quay lại Loki tìm log của DB service   [10 phút]
7. Cuối cùng tìm ra root cause            [10 phút]
                                   Total: ~45 phút
```

### Obs 2.0 — 5 phút

```
1. Alert tự động với AI summary đính kèm  [0 phút — tự đến]
2. HyperDX: search user.id hoặc error.type [1 phút]
3. Click vào span → thấy toàn bộ context  [1 phút]
4. Click sang trace → thấy DB timeout     [1 phút]
5. Xác nhận root cause, bắt đầu fix       [2 phút]
                                   Total: ~5 phút
```

---

## Tham khảo

Observability 2.0 không phải khái niệm mới. Được đề xuất và phát triển bởi:

- **Charity Majors** (Honeycomb CTO) — người đặt ra thuật ngữ, bài viết gốc: [One Key Difference Between Observability 1.0 and 2.0](https://honeycomb.io/blog/one-key-difference-observability1dot0-2dot0)
- **OpenTelemetry project** — chuẩn open-source cho instrumentation, được hỗ trợ bởi Google, Microsoft, AWS, Datadog
- **ClickHouse** — database được Netflix, Cloudflare, Uber dùng cho observability workload ở quy mô lớn

---

*Tiếp theo: [`02-core-concepts.md`](02-core-concepts.md) — Span, trace, wide event là gì cụ thể*
