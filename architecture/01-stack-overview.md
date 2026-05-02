# Kiến trúc tổng quan


---

## Sơ đồ tổng thể

![Observability architecture](Observability-architecture.png)

---

## L1 — Instrumentation

**Namespace:** `apps`

Tầng này là nơi wide events được sinh ra. Mỗi thành phần có cách instrument khác nhau:

| Thành phần | Cách instrument | Loại event |
|---|---|---|
| Http API | OTel SDK auto-instrument | Wide event per request |
| Worker/Job | OTel SDK manual | Wide event per job execution |
| Frontend | HyperDX RUM SDK | Session replay + client traces |
| Nginx/Redis | OTel Collector filelog | Infra log |
| Kubernetes | kube-state-metrics + node-exporter | System metrics + events |

**Điểm quan trọng:** Metrics không được emit từ tầng này. Chỉ có traces và logs. Metrics sẽ được derive ở L3.

---

## L2 — OTel Collector

**Namespace:** `observability`

Collector là điểm tập trung duy nhất — không service nào ghi thẳng vào ClickHouse.

### Kiến trúc 2 tầng

**Agent (DaemonSet — 1 pod/node):**
- Nhận OTLP gRPC từ app trên cùng node
- Đọc filelog từ `/var/log/pods`
- Inject K8s metadata (pod, namespace, node)
- Forward lên Gateway

**Gateway (Deployment — 3 replicas):**
- Nhận data từ tất cả Agent
- Thực hiện tail-sampling (100% error, 10% success)
- Transform, filter, batch
- Export OTLP/HTTP vào ClickHouse

### Tại sao cần 2 tầng?

Tail-sampling phải thấy **toàn bộ trace** mới quyết định giữ hay bỏ. Nếu chỉ có 1 tầng, mỗi Agent chỉ thấy spans của node mình — không đủ để quyết định.

### Pipeline xử lý

```
Filter → Enrich → Tail Sampling → Batch → Export
  │         │           │            │
drop      inject     100% err     8192/batch
health    k8s meta   10% ok       gzip
check     env/team
```

---

## L3 — ClickHouse

**Altinity ClickHouse Operator | 3 shards × 2 replicas**

Trái tim của toàn bộ stack. Thay thế Prometheus + Loki + Jaeger bằng 1 engine duy nhất.

### Schema chính

**`otel_traces`** — Primary table, wide events từ application:
```sql
CREATE TABLE otel_traces (
    Timestamp           DateTime64(9),
    TraceId             String,
    SpanId              String,
    ParentSpanId        String,
    SpanName            String,
    SpanKind            String,
    ServiceName         String,
    Duration            Int64,         -- nanoseconds
    StatusCode          String,
    StatusMessage       String,
    SpanAttributes      Map(String, String),
    ResourceAttributes  Map(String, String),
    -- ...
) ENGINE = MergeTree()
PARTITION BY toDate(Timestamp)
ORDER BY (ServiceName, SpanName, toUnixTimestamp(Timestamp), TraceId)
```

**`otel_logs`** — Infra và system logs (Nginx, Redis, K8s events)

**`otel_metrics`** — Materialized View, tự động derive từ `otel_traces`:
```sql
CREATE MATERIALIZED VIEW otel_metrics
ENGINE = AggregatingMergeTree()
AS SELECT
    ServiceName,
    SpanName,
    toStartOfMinute(Timestamp) AS ts,
    countIf(StatusCode = 'STATUS_CODE_ERROR')        AS error_count,
    count()                                           AS total_count,
    quantileState(0.99)(Duration / 1e6)               AS p99_ms
FROM otel_traces
WHERE SpanKind = 'SPAN_KIND_SERVER'
GROUP BY ServiceName, SpanName, ts
```

### Tiered storage

- **Hot (SSD):** 0–30 ngày, fast read cho real-time queries
- **Cold (MinIO):** >30 ngày, tự động migrate, S3-compatible, on-prem

### Compression thực tế

ZSTD compression ratio với observability data: **8–10x**  
100 GB raw data → ~10–12 GB trên disk.

---

## L4 — AI Analysis (Optional)

**Chạy async trên read replica — không ảnh hưởng production traffic**

| Component | Thuật toán | Chạy khi |
|---|---|---|
| Anomaly Detection | MAD / IQR / Prophet | Streaming, liên tục |
| Root Cause AI | Correlation + LLM summary | On-demand khi có alert |
| Log Clustering | Drain algorithm | Batch mỗi 15 phút |
| SLO Burn Rate | Multi-window (1h/6h/24h/72h) | Streaming |

**Deploy sau cùng** — cần ít nhất 2 tuần data để hoạt động tốt.

---

## L5 — Visualization

3 tool, 3 use case rõ ràng — không overlap:

| Tool | Dùng khi | Người dùng chính |
|---|---|---|
| **HyperDX** | Debug incident, tìm root cause, không biết cần tìm gì | On-call engineer |
| **Grafana** | Xem dashboard thường ngày, set alert cho known issues | All team |
| **Slack/PagerDuty** | Nhận alert P1/P2, on-call routing | On-call engineer |

**HyperDX** = unknown-unknowns (bạn không biết mình cần tìm gì)  
**Grafana** = known-knowns (bạn đã biết cần monitor gì)

---

## L+ — Cross-cutting concerns

| Component | Mục đích |
|---|---|
| Nginx/Traefik Ingress | TLS termination, route /hyperdx và /grafana |
| Keycloak (OIDC) | SSO cho HyperDX + Grafana, RBAC per team |
| K8s NetworkPolicy | ClickHouse chỉ accept từ OTel Collector + HyperDX |
| clickhouse-backup | Daily snapshot → MinIO, test restore hàng tháng |

---

*Tiếp theo: [`02-layer-by-layer.md`](02-layer-by-layer.md) — Giải thích chi tiết từng tầng*
