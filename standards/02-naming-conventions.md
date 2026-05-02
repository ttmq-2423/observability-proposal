# Quy tắc đặt tên Attribute


## 3 quy tắc cốt lõi

### 1. Format: `namespace.field_name`

```
user.id           order.total        job.outcome
payment.method    feature.flag       error.type
```

### 2. Tất cả viết thường, dùng gạch dưới trong field name

```
✅  user.id            order.item_count       job.max_retry
❌  User.ID            order.itemCount        job.maxRetry
❌  USER.ID            order.item-count       job.max-retry
```

### 3. ID luôn là string

```typescript
✅  span.setAttribute('user.id', String(user.id))   // "99"
❌  span.setAttribute('user.id', user.id)            // 99 (number)
```

Lý do: ClickHouse high-cardinality query trên string column hiệu quả hơn mixed-type.

---

## Danh sách namespace chuẩn

| Namespace | Dùng cho | Ví dụ |
|---|---|---|
| `user.*` | User đang thực hiện request | `user.id`, `user.plan`, `user.type` |
| `job.*` | Background job, worker | `job.id`, `job.queue`, `job.attempt` |
| `error.*` | Thông tin lỗi | `error.type`, `error.code` |
| `feature.*` | Feature flag | `feature.flag`, `feature.variant` |
| `request.*` | Outcome của request | `request.outcome` |
| `http.*` | HTTP metadata (SDK tự điền) | `http.method`, `http.status_code` |
| `db.*` | Database (SDK tự điền) | `db.system`, `db.query.text` |
| `<entity>.*` | Domain của từng team | `order.*`, `payment.*`, `loan.*` |

---

## Giá trị chuẩn cho enum

Thống nhất giá trị giúp query và dashboard không bị sai.

| Attribute | Giá trị hợp lệ |
|---|---|
| `request.outcome` | `success` / `error` / `partial` |
| `job.outcome` | `success` / `failed` / `skipped` |
| `user.type` | `human` / `bot` / `service_account` |
| `error.is_retryable` | `true` / `false` (boolean) |

---

## Không đặt tên như này

```
❌  _userId          (bắt đầu bằng underscore)
❌  my.custom.thing  (quá vague, thiếu context domain)
❌  temp             (không có namespace)
❌  data             (quá generic)
❌  info.x           (namespace không có ý nghĩa)
```
