# examples/python-http-span.py
# Wide event cho HTTP API — Python / FastAPI
# Copy và adapt cho service của bạn

from opentelemetry import trace
from opentelemetry.trace import Status, StatusCode

@router.post("/orders")
async def create_order(
    body: OrderRequest,
    current_user: User = Depends(get_current_user),
):
    span = trace.get_current_span()

    # Thêm business context ngay đầu handler
    span.set_attributes({
        # User context (bắt buộc)
        "user.id":   str(current_user.id),
        "user.plan": current_user.plan,

        # Domain-specific (thay bằng entity của service bạn)
        "order.total":      float(body.total),
        "order.item_count": len(body.items),
        "payment.method":   body.payment_method,
    })

    try:
        order = await order_service.create(body, current_user)

        span.set_attributes({
            "order.id":        str(order.id),
            "order.status":    order.status,
            "request.outcome": "success",
        })
        return order

    except PaymentError as e:
        span.record_exception(e)
        span.set_status(Status(StatusCode.ERROR, str(e)))
        span.set_attributes({
            "error.type":         "PaymentError",
            "error.code":         e.code,
            "error.is_retryable": False,
            "request.outcome":    "error",
        })
        raise
