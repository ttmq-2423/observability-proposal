# Lộ trình chuyển đổi

> Nguyên tắc: **Không big bang. Không bỏ stack cũ cho đến khi team tin tưởng stack mới ít nhất 4 tuần.**

---

## Tổng quan lộ trình

```
Tuần 1–2    Tuần 3–4    Tháng 2     Tháng 3+
────────────────────────────────────────────────
Deploy nền  Instrument  Mở rộng     Tắt stack cũ
                        & validate  & AI layer
```

---

## Giai đoạn 1 — Deploy nền (Tuần 1–2)

**Mục tiêu:** Hạ tầng sẵn sàng. Chưa đụng đến application code.

**Việc cần làm:**

1. Deploy ClickHouse cluster qua Altinity Operator (3 shards × 2 replicas)
2. Deploy MinIO cho cold storage
3. Deploy OTel Collector (Agent DaemonSet + Gateway Deployment)
4. Deploy HyperDX, kết nối với ClickHouse
5. Cấu hình Grafana ClickHouse datasource plugin
6. Cấu hình K8s NetworkPolicy và OIDC auth (Keycloak)

**Verify:**

```bash
# ClickHouse nhận kết nối
clickhouse-client --query "SELECT 1"

# OTel Collector đang chạy
kubectl get pods -n observability

# HyperDX mở được
curl -f http://hyperdx.internal/health
```

**Chưa làm:** Chưa thay đổi bất kỳ application service nào.

---

## Giai đoạn 2 — Pilot service (Tuần 3–4)

**Mục tiêu:** Chọn 1 service ít rủi ro nhất, instrument đầy đủ, verify data.

**Chọn service pilot theo tiêu chí:**
- Không quá critical (tránh payment service lần đầu)
- Team hiểu rõ business logic của service đó
- Có đủ traffic để kiểm tra sampling

**Việc cần làm:**

1. Thêm OTel SDK vào service pilot (xem `guides/`)
2. Thêm business context vào mọi endpoint
3. Set đủ biến môi trường trong K8s manifest
4. **Dual-write:** vẫn giữ log cũ, đồng thời ghi vào ClickHouse
5. Verify trong HyperDX: span xuất hiện với đủ attribute

**Verify:**

```sql
-- Span của service pilot đã vào ClickHouse chưa?
SELECT service_name, count(), avg(duration_ns)/1e6 AS avg_ms
FROM otel_traces
WHERE timestamp > now() - INTERVAL 1 HOUR
  AND service_name = 'your-pilot-service'
GROUP BY service_name

-- Attribute quan trọng có đủ không?
SELECT
    countIf(SpanAttributes['user.id'] != '') * 100 / count() AS user_id_pct,
    countIf(SpanAttributes['request.outcome'] != '') * 100 / count() AS outcome_pct
FROM otel_traces
WHERE service_name = 'your-pilot-service'
  AND timestamp > now() - INTERVAL 1 HOUR
  AND SpanKind = 'SPAN_KIND_SERVER'
```

**Kỳ vọng:** `user_id_pct > 90%`, `outcome_pct = 100%`.

---

## Giai đoạn 3 — Mở rộng (Tháng 2)

**Mục tiêu:** Roll out sang toàn bộ services. Bắt đầu dùng HyperDX làm tool debug chính.

**Việc cần làm:**

1. Cài OTel Operator vào K8s cluster — auto-inject SDK vào pod qua annotation
2. Instrument từng service theo thứ tự ưu tiên (critical path trước)
3. Migrate Grafana dashboards: đổi datasource từ Prometheus → ClickHouse Materialized View
4. Team bắt đầu dùng HyperDX cho incident investigation thực tế
5. Giảm Prometheus retention xuống 7 ngày (giữ làm fallback)

**Thứ tự ưu tiên instrument service:**

```
1. API Gateway / BFF          ← điểm vào duy nhất, high value
2. Core business services     ← order, payment, user...
3. Supporting services        ← notification, search...
4. Internal tools             ← admin panel, backoffice...
```

---

## Giai đoạn 4 — Hoàn thiện (Tháng 3+)

**Mục tiêu:** Tắt stack cũ. Deploy AI layer.

**Điều kiện để tắt stack cũ:**
- Team đã dùng ClickHouse/HyperDX làm primary tool ít nhất 4 tuần liên tục
- Không có incident nào phải quay lại Prometheus/Loki để debug
- Mọi Grafana dashboard đã migrate xong

**Việc cần làm:**

1. Tắt Loki/Jaeger
2. Giảm Prometheus về minimal (chỉ giữ alerting rules chưa migrate)
3. Deploy AI Analysis layer:
   - Anomaly detection (MAD/IQR cho time-series)
   - Log clustering (Drain algorithm)
   - SLO Burn Rate multi-window alerting
4. Setup `clickhouse-backup` CronJob — test restore ít nhất 1 lần

---

## Checklist dual-write (giai đoạn 2–3)

Trong thời gian chuyển đổi, mỗi service chạy song song cả 2 hệ thống:

```
┌──────────────────────────────────────────┐
│  Application                              │
│  ├── OTel SDK → OTel Collector → ClickHouse  (mới)
│  └── Logger   → Loki/ELK                    (cũ, giữ nguyên)
└──────────────────────────────────────────┘
```

Điều này giúp:
- Không mất data nếu stack mới có vấn đề
- Team có thể verify data giữa 2 hệ thống
- Rollback dễ dàng nếu cần

Chi phí: tốn thêm CPU/memory để write 2 nơi. Chấp nhận được trong giai đoạn chuyển đổi.

---

## Rủi ro và cách giảm thiểu

| Rủi ro | Xác suất | Cách giảm thiểu |
|---|---|---|
| ClickHouse node down | Thấp | 3 shards × 2 replicas, Altinity Operator tự recover |
| Data loss khi OTel Collector restart | Thấp | Persistent queue trong Collector |
| Dev không follow spec | Cao | Checklist trong PR template, validation query |
| Performance impact của SDK | Thấp | Benchmark cho thấy < 2% overhead |
| Grafana dashboard break | Trung bình | Migrate từng dashboard, giữ datasource cũ song song |

---

*Tiếp theo: [`../architecture/01-stack-overview.md`](../architecture/01-stack-overview.md) — Chi tiết kiến trúc kỹ thuật*
