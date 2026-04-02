from typing import TypeVar, Type

from fastapi import HTTPException
from sqlalchemy.orm import Session

T = TypeVar("T")


def get_or_404(db: Session, model: Type[T], pk, detail: str) -> T:
    """Fetch by primary key; raise HTTP 404 if not found."""
    obj = db.get(model, pk)
    if obj is None:
        raise HTTPException(status_code=404, detail=detail)
    return obj


def query_or_404(db: Session, stmt, detail: str):
    """Execute scalar query; raise HTTP 404 if no result."""
    obj = db.execute(stmt).scalar_one_or_none()
    if obj is None:
        raise HTTPException(status_code=404, detail=detail)
    return obj
