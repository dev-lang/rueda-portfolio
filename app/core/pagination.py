from sqlalchemy.orm import Session
from sqlalchemy import select, func


def paginate(
    db: Session,
    stmt,
    page: int,
    per_page: int,
    order_by=None,
    scalars: bool = True,
    max_per_page: int = 500,
) -> tuple[list, dict]:
    """
    Executes a filtered statement with pagination.

    Returns (items, meta) where meta = {total, pages, current_page, per_page}.

    order_by: SQLAlchemy column expression, e.g. Model.col.desc().
    scalars: True for single-model queries (.scalars().all()),
             False for multi-model joins (.all()).
    max_per_page: upper bound for per_page clamping (default 500).
    """
    per_page = max(1, min(per_page, max_per_page))
    page = max(1, page)

    total = db.execute(
        select(func.count()).select_from(stmt.subquery())
    ).scalar() or 0

    pages = max((total + per_page - 1) // per_page, 1)
    page = min(page, pages)

    q = stmt
    if order_by is not None:
        q = q.order_by(order_by)
    q = q.offset((page - 1) * per_page).limit(per_page)

    items = db.execute(q).scalars().all() if scalars else db.execute(q).all()

    return items, {
        "total": total,
        "pages": pages,
        "current_page": page,
        "per_page": per_page,
    }
