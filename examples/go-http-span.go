// examples/go-http-span.go
// Wide event cho HTTP API — Go / Gin
// Copy và adapt cho service của bạn

package handler

import (
    "fmt"
    "github.com/gin-gonic/gin"
    "go.opentelemetry.io/otel/attribute"
    "go.opentelemetry.io/otel/codes"
    "go.opentelemetry.io/otel/trace"
)

func (h *OrderHandler) CreateOrder(c *gin.Context) {
    // otelgin middleware đã tạo span — chỉ cần lấy ra
    span := trace.SpanFromContext(c.Request.Context())

    var body CreateOrderRequest
    if err := c.ShouldBindJSON(&body); err != nil {
        c.JSON(400, gin.H{"error": err.Error()})
        return
    }
    user := c.MustGet("user").(*User)

    // Thêm business context ngay đầu handler
    span.SetAttributes(
        // User context (bắt buộc)
        attribute.String("user.id",   user.ID),
        attribute.String("user.plan", user.Plan),

        // Domain-specific (thay bằng entity của service bạn)
        attribute.Float64("order.total",    body.Total),
        attribute.Int("order.item_count",   len(body.Items)),
        attribute.String("payment.method",  body.PaymentMethod),
    )

    order, err := h.orderService.Create(c.Request.Context(), body, user)
    if err != nil {
        span.RecordError(err)
        span.SetStatus(codes.Error, err.Error())
        span.SetAttributes(
            attribute.String("error.type",    fmt.Sprintf("%T", err)),
            attribute.String("request.outcome", "error"),
        )
        c.JSON(500, gin.H{"error": err.Error()})
        return
    }

    span.SetAttributes(
        attribute.String("order.id",          order.ID),
        attribute.String("order.status",      order.Status),
        attribute.String("request.outcome",   "success"),
    )
    c.JSON(201, order)
}
