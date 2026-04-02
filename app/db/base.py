from sqlalchemy import create_engine
from sqlalchemy.orm import declarative_base
from app.core.config import settings

engine = create_engine(
    settings.DATABASE_URL,
    connect_args={"check_same_thread": False},  # SQLite only
    # For PostgreSQL in production, remove connect_args and set pool_size, max_overflow
)

Base = declarative_base()
