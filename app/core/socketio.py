import socketio
from app.core.config import settings

# Mirror the same allowed origins as the FastAPI CORS middleware.
# Configured via CORS_ORIGINS env var (comma-separated).
# Authentication is validated in the connect event handler in app/main.py.
sio = socketio.AsyncServer(
    async_mode="asgi",
    cors_allowed_origins=settings.CORS_ORIGINS,
)
