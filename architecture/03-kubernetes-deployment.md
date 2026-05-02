# Kubernetes Deployment — Sizing & Cấu hình

> Tài liệu này dành cho DevOps / Platform team.  
> Ví dụ Sizing cho quy mô **10–100 GB observability data / ngày**, K8s self-hosted.

---

## Namespace layout

```
observability/     ← OTel Collector, ClickHouse, MinIO
monitoring/        ← Grafana, AlertManager, VictoriaMetrics
hyperdx/           ← HyperDX UI + API
```

---

## Sizing tham khảo

| Component | CPU | RAM | Storage | Replicas |
|---|---|---|---|---|
| OTel Collector Agent | 0.5 | 512 MB | — | 1/node (DaemonSet) |
| OTel Collector Gateway | 2 | 2 GB | 10 GB (persistent queue) | 3 |
| ClickHouse (hot) | 8 | 32 GB | 500 GB NVMe SSD | 6 (3s×2r) |
| ClickHouse Keeper | 1 | 2 GB | 20 GB | 3 |
| MinIO (cold) | 4 | 8 GB | 10 TB HDD | 4 |
| HyperDX | 2 | 4 GB | — | 2 |
| Grafana | 1 | 2 GB | — | 2 |
| AlertManager | 0.5 | 512 MB | — | 2 |

**Lưu ý:** Với ZSTD compression ~8–10x, 100 GB/ngày raw data ≈ 10–12 GB/ngày trên disk.  
500 GB SSD hot tier = ~40–50 ngày data trước khi tier xuống MinIO.

---

## OTel Collector — cấu hình mẫu

### Agent (DaemonSet)

```yaml
# k8s/otel-collector-agent.yaml
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: otel-collector-agent
  namespace: observability
spec:
  selector:
    matchLabels:
      app: otel-collector-agent
  template:
    spec:
      containers:
        - name: collector
          image: otel/opentelemetry-collector-contrib:0.98.0
          resources:
            requests: { cpu: 250m, memory: 256Mi }
            limits:   { cpu: 500m, memory: 512Mi }
          volumeMounts:
            - name: varlogpods
              mountPath: /var/log/pods
              readOnly: true
            - name: config
              mountPath: /etc/otelcol
      volumes:
        - name: varlogpods
          hostPath: { path: /var/log/pods }
        - name: config
          configMap: { name: otel-collector-agent-config }
```

### Agent config

```yaml
# otel-collector-agent-config.yaml
receivers:
  otlp:
    protocols:
      grpc: { endpoint: 0.0.0.0:4317 }
  filelog:
    include:
      - /var/log/pods/*/*/*.log
    operators:
      - type: json_parser
      - type: k8s_metadata_decorator

processors:
  batch:
    timeout: 1s
    send_batch_size: 1024
  k8sattributes:
    extract:
      metadata: [k8s.pod.name, k8s.namespace.name, k8s.node.name,
                 k8s.deployment.name, k8s.container.name]
    pod_association:
      - sources: [{ from: resource_attribute, name: k8s.pod.ip }]

exporters:
  otlp:
    endpoint: otel-collector-gateway:4317
    tls: { insecure: true }

service:
  pipelines:
    traces:
      receivers:  [otlp]
      processors: [k8sattributes, batch]
      exporters:  [otlp]
    logs:
      receivers:  [filelog]
      processors: [k8sattributes, batch]
      exporters:  [otlp]
```

### Gateway config (tail-sampling)

```yaml
# otel-collector-gateway-config.yaml
receivers:
  otlp:
    protocols:
      grpc: { endpoint: 0.0.0.0:4317 }
      http: { endpoint: 0.0.0.0:4318 }

processors:
  filter/health_check:
    traces:
      span:
        - 'attributes["http.route"] == "/health"'
        - 'attributes["http.route"] == "/ready"'
        - 'attributes["http.route"] == "/metrics"'

  tail_sampling:
    decision_wait: 10s
    num_traces: 100000
    policies:
      - name: errors-policy
        type: status_code
        status_code: { status_codes: [ERROR] }
      - name: slow-traces
        type: latency
        latency: { threshold_ms: 1000 }
      - name: probabilistic-policy
        type: probabilistic
        probabilistic: { sampling_percentage: 10 }

  batch:
    timeout: 5s
    send_batch_size: 8192

exporters:
  clickhouse:
    endpoint: tcp://clickhouse:9000
    database: otel
    ttl: 720h  # 30 days hot tier
    compress: lz4
    async_insert: true

service:
  pipelines:
    traces:
      receivers:  [otlp]
      processors: [filter/health_check, tail_sampling, batch]
      exporters:  [clickhouse]
    logs:
      receivers:  [otlp]
      processors: [batch]
      exporters:  [clickhouse]
```

---

## ClickHouse — cấu hình Altinity Operator

```yaml
# k8s/clickhouse-cluster.yaml
apiVersion: clickhouse.altinity.com/v1
kind: ClickHouseInstallation
metadata:
  name: clickhouse-obs
  namespace: observability
spec:
  configuration:
    clusters:
      - name: obs
        layout:
          shardsCount: 3
          replicasCount: 2

    zookeeper:
      nodes:
        - host: clickhouse-keeper-0.observability.svc
        - host: clickhouse-keeper-1.observability.svc
        - host: clickhouse-keeper-2.observability.svc

    settings:
      max_memory_usage: 27000000000       # 27 GB (leave 5GB for OS)
      max_bytes_to_read: 100000000000
      background_pool_size: 4
      max_concurrent_queries: 100

  templates:
    podTemplates:
      - name: clickhouse-pod
        spec:
          containers:
            - name: clickhouse
              image: clickhouse/clickhouse-server:24.3
              resources:
                requests: { cpu: 6, memory: 28Gi }
                limits:   { cpu: 8, memory: 32Gi }
          volumeClaimTemplates:
            - name: data
              spec:
                accessModes: [ReadWriteOnce]
                storageClassName: fast-ssd
                resources:
                  requests: { storage: 500Gi }
```

---

## Tiered storage — ClickHouse + MinIO

```xml
<!-- config.xml snippet cho ClickHouse -->
<storage_configuration>
  <disks>
    <default>
      <type>local</type>
      <path>/var/lib/clickhouse/</path>
    </default>
    <minio>
      <type>s3</type>
      <endpoint>http://minio.observability.svc:9000/clickhouse/</endpoint>
      <access_key_id>MINIO_ACCESS_KEY</access_key_id>
      <secret_access_key>MINIO_SECRET_KEY</secret_access_key>
    </minio>
  </disks>
  <policies>
    <tiered>
      <volumes>
        <hot>
          <disk>default</disk>
          <max_data_part_size_bytes>1073741824</max_data_part_size_bytes>
        </hot>
        <cold>
          <disk>minio</disk>
        </cold>
      </volumes>
      <move_factor>0.2</move_factor>
    </tiered>
  </policies>
</storage_configuration>
```

Data cũ hơn 30 ngày tự động migrate xuống MinIO khi hot tier vượt 80% capacity.

---

## K8s NetworkPolicy

```yaml
# Chỉ cho phép OTel Collector và HyperDX truy cập ClickHouse
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: clickhouse-ingress
  namespace: observability
spec:
  podSelector:
    matchLabels:
      app: clickhouse
  ingress:
    - from:
        - namespaceSelector:
            matchLabels:
              name: observability
          podSelector:
            matchLabels:
              app: otel-collector-gateway
        - namespaceSelector:
            matchLabels:
              name: hyperdx
      ports:
        - port: 9000   # TCP native
        - port: 8123   # HTTP
```

---

## Backup

```yaml
# CronJob chạy daily backup
apiVersion: batch/v1
kind: CronJob
metadata:
  name: clickhouse-backup
  namespace: observability
spec:
  schedule: "0 2 * * *"   # 2 AM hàng ngày
  jobTemplate:
    spec:
      template:
        spec:
          containers:
            - name: backup
              image: altinity/clickhouse-backup:2.4.0
              env:
                - name: S3_BUCKET
                  value: clickhouse-backup
                - name: S3_ENDPOINT
                  value: http://minio.observability.svc:9000
              command:
                - clickhouse-backup
                - create_remote
                - "--backups-to-keep-remote=7"
```

**Quan trọng:** Test restore ít nhất 1 lần/tháng trước khi tắt stack cũ.

```bash
# Test restore
clickhouse-backup restore_remote <backup-name>
```
