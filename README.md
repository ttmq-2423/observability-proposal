# Observability 2.0 — Đề xuất kiến trúc giám sát thế hệ mới

> Tài liệu này trình bày toàn bộ chiến lược chuyển đổi sang Observability 2.0:  
> từ **tư duy**, **kiến trúc**, **chuẩn dữ liệu**, đến **hướng dẫn triển khai**.

---

## Đọc theo thứ tự này
Đọc `docs/` và `architecture/` trước để hiểu được chiến lược Observability 2.0.



```
📁 observability-proposal/
│
├── 📄 README.md                          ← Bạn đang đọc file này
│
├── 📁 docs/                              ← Khái niệm & tư duy
│   ├── 01-why-observability-2.0.md       ← Tại sao cần thay đổi
│   ├── 02-core-concepts.md               ← Wide event, trace, span là gì
│   ├── 03-request-flow-patterns.md       ← Các pattern request trong microservices
│   └── 04-migration-strategy.md          ← Lộ trình chuyển đổi từng bước
│
├── 📁 architecture/                      ← Thiết kế hệ thống
│   ├── 01-stack-overview.md              ← Stack tổng quan (OTel → ClickHouse → HyperDX)
│   ├── 02-layer-by-layer.md              ← Giải thích từng tầng L1→L5
│   └── 03-kubernetes-deployment.md       ← Sizing, namespaces, operators
│
├── 📁 standards/                         ← Chuẩn dữ liệu bắt buộc
│   ├── 01-wide-event-spec.md             ← Spec đầy đủ các attribute
│   └── 02-naming-conventions.md          ← Quy tắc đặt tên
│
├── 📁 guides/                            ← Hướng dẫn thực hành cho dev
│   ├── 01-setup-nodejs.md                ← Setup OTel cho Node.js
│   ├── 02-setup-python.md                ← Setup OTel cho Python
│   ├── 03-setup-go.md                    ← Setup OTel cho Go
│   └── 04-worker-job-guide.md            ← Hướng dẫn instrument Worker/Job
│
└── 📁 examples/                          ← Code mẫu tham khảo
    ├── nodejs-http-span.ts               ← Wide event cho HTTP API (Node.js)
    ├── python-http-span.py               ← Wide event cho HTTP API (Python)
    ├── go-http-span.go                   ← Wide event cho HTTP API (Go)
    └── worker-span.ts                    ← Wide event cho Worker/Job
```

---

## Tóm tắt  — Observability 2.0 là gì

### Vấn đề của cách làm cũ (Obs 1.0)

Hiện tại hầu hết hệ thống đang dùng 3 công cụ riêng lẻ:

```
Prometheus  → metrics (error rate, latency p99)
Loki/ELK    → logs (application log lines)
Jaeger      → traces (distributed tracing)
```

Khi có incident, kỹ sư phải nhảy qua lại giữa 3 tool, 3 query language khác nhau, với data không nhất quán. Mất 30–60 phút chỉ để tìm ra nguyên nhân.

### Giải pháp — Obs 2.0

```
Mọi thứ → 1 wide event → ClickHouse (single source of truth)
```

Thay vì emit 3 luồng riêng, mỗi request tạo **1 structured record** chứa toàn bộ context:

```json
{
  "trace_id": "abc123",
  "service":  "order-service",
  "user.id":  "usr_99",
  "order.id": "ord_456",
  "duration_ms": 145,
  "http.status": 200,
  "db.query": "INSERT INTO orders...",
  "cache.hit": true,
  "feature.flag": "new-checkout"
}
```

Từ 1 record này có thể derive ra metrics, logs, traces — không cần 3 hệ thống riêng.

### Stack được chọn

| Tầng | Công cụ | Vai trò |
|---|---|---|
| Instrumentation | OpenTelemetry SDK | Emit wide events từ mọi service |
| Transport | OTel Collector | Collect, filter, sample, forward |
| Storage | ClickHouse | Single source of truth |
| Cold storage | MinIO | Data > 30 ngày |
| Exploration | HyperDX | Debug incident, unknown-unknowns |
| Dashboard | Grafana | Dashboard thường ngày, alerting |
| Alerting | Slack / PagerDuty | P1/P2 notification |


---

## Điểm khác biệt với kiến trúc Obs 1.0

| | Obs 1.0 | Obs 2.0  |
|---|---|---|
| Data model | 3 silo riêng biệt | 1 wide event duy nhất |
| Metrics | Emit từ application code | Derive tự động từ traces |
| Cross-signal debug | Phải JOIN thủ công | JOIN bằng `trace_id` |
| Query language | PromQL + LogQL + trace DSL | SQL thuần |
| Storage | 3 hệ thống riêng | ClickHouse duy nhất |
| Session replay | Không có | HyperDX RUM SDK |
| AI analysis | Không có | Anomaly detection + root cause |


---

*Questions? Slack `#observability`*  
*Kiến trúc diagram: xem file `obs2_architecture.html` hoặc `obs2_architecture.excalidraw`*
