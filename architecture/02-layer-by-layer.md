# Giải thích từng tầng

> Chi tiết mục đích, thành phần, và lý do thiết kế của từng layer.

---

## L1 — Instrumentation: nơi wide events được sinh ra

**Triết lý:** Không emit 3 luồng riêng. Mỗi request chỉ tạo 1 wide event chứa toàn bộ context.

**Các thành phần:**

- **Http API / Worker** — OTel SDK auto-instrument. SDK hook vào HTTP framework và database client, tự tạo span khi có request/query. Dev chỉ cần thêm business context (`user.id`, entity ID...).

- **Frontend Browser** — HyperDX RUM SDK. Optional, dùng khi cần debug lỗi user-facing mà backend log không giải thích được. Ghi session replay + client-side traces + Core Web Vitals.

- **Nginx / Redis** — OTel Collector filelog receiver đọc `/var/log/pods`. Không cần Fluentd/Filebeat riêng.

- **Kubernetes** — kube-state-metrics + node-exporter. K8s events (OOMKilled, CrashLoop) được đẩy vào cùng pipeline để correlate với application traces.

**Điều quan trọng:** Metrics KHÔNG được emit từ tầng này. Chỉ có traces và logs.

---

## L2 — OTel Collector: wide events gateway

**Triết lý:** Điểm tập trung duy nhất. Không service nào ghi thẳng vào ClickHouse.

**Tại sao cần 2 tầng (Agent + Gateway):**

Tail-sampling cần thấy toàn bộ trace (tất cả spans từ nhiều services) mới quyết định giữ hay bỏ. Agent trên từng node chỉ thấy spans của node đó. Gateway nhìn thấy toàn bộ → mới làm được tail-sampling đúng cách.

**Pipeline xử lý:**

1. **Filter** — Bỏ health-check endpoints, spans quá ngắn, log level DEBUG
2. **Enrich** — Inject K8s metadata: namespace, pod, node, deployment, team
3. **Tail Sampling** — Ví dụ giữ 100% error/slow traces, bỏ 90% success traces
4. **Batch** — Gom 8192 spans/batch, gzip compress trước khi ghi ClickHouse

---

## L3 — ClickHouse: single source of truth

**Triết lý:** Thay thế Prometheus + Loki + Jaeger bằng 1 engine. Mọi tín hiệu có thể JOIN bằng SQL.

**Tại sao ClickHouse:**

- Columnar storage: observability queries thường scan 1–2 column trên hàng triệu rows → columnar nhanh hơn row-based 5–30x
- ZSTD compression:nén dữ liệu xuống 8–10x với observability data
- Materialized View: tự động tính metrics incremental từ traces — không cần pre-aggregate ở application

**otel_metrics là Materialized View, không phải table:**

Metrics không được emit từ app nữa. Khi có trace mới insert vào `otel_traces`, ClickHouse tự cập nhật `otel_metrics` (error_rate, p99 latency, RPS). Incremental — không scan lại toàn bộ data mỗi lần query dashboard.

**Tiered storage:** Hot (SSD, 0–30 ngày) → Cold (MinIO, >30 ngày). Tự động, transparent — query vẫn chạy bình thường dù data ở cold tier.

---

## L4 — AI Analysis: tầng optional

**Triết lý:** Phát hiện vấn đề mà team chưa biết cần tìm. Chạy async trên read replica — không ảnh hưởng production.

- **Anomaly Detection** — không cần đặt threshold cứng. Dùng MAD/IQR tự phát hiện spike/drop bất thường.
- **Root Cause AI** — khi có alert, tự correlate trace → log → deploy gần nhất, LLM tóm tắt nguyên nhân.
- **Log Clustering** — Drain algorithm gom pattern, giảm noise từ hàng triệu dòng xuống vài trăm pattern.
- **SLO Burn Rate** — multi-window (1h/6h/24h/72h), cảnh báo sớm trước khi SLO bị vi phạm.

**Deploy sau cùng** — cần ít nhất 2 tuần data và team đã quen với L1–L3.

---

## L5 — Visualization: 3 tool, 3 vai trò

**HyperDX** = dùng khi đang debug incident, chưa biết root cause là gì (unknown-unknowns).

Workflow: search theo `user.id` hoặc `error.type` → thấy trace → click sang session replay → thấy đúng khoảnh khắc lỗi xảy ra. Toàn bộ trong 1 tool, không cần nhảy đi đâu.

**Grafana** = dùng cho dashboard thường ngày, set alert rule cho những thứ đã biết cần monitor (known-knowns).


**Slack** = routing alert → Slack channel. AI summary từ L4 đính kèm để on-call có context ngay mà không cần vào HyperDX trước.
