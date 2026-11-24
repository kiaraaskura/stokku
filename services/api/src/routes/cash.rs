use chrono::NaiveDate;
use rust_decimal::Decimal;
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::Row;
use uuid::Uuid;

use axum::extract::{Path, Query, State};
use axum::Json;

use crate::ctx::{AuthCtx, Cap};
use crate::error::{ApiError, ApiResult};
use crate::state::AppState;
use crate::util::{begin_tx, now_v7, parse_date, today_jakarta};

fn entry_row_json(row: &sqlx::postgres::PgRow) -> ApiResult<Value> {
    Ok(json!({
        "id": row.try_get::<Uuid, _>("id")?,
        "outlet_id": row.try_get::<Uuid, _>("outlet_id")?,
        "direction": row.try_get::<String, _>("direction")?,
        "amount": row.try_get::<i64, _>("amount")?,
        "category": row.try_get::<String, _>("category")?,
        "method": row.try_get::<Option<String>, _>("method")?,
        "ref_type": row.try_get::<Option<String>, _>("ref_type")?,
        "ref_id": row.try_get::<Option<Uuid>, _>("ref_id")?,
        "business_date": row.try_get::<NaiveDate, _>("business_date")?,
        "note": row.try_get::<Option<String>, _>("note")?,
        "op_id": row.try_get::<Option<Uuid>, _>("op_id")?,
        "created_by": row.try_get::<Option<Uuid>, _>("created_by")?,
        "created_at": row.try_get::<chrono::DateTime<chrono::Utc>, _>("created_at")?,
    }))
}

#[derive(Deserialize)]
pub struct CashEntryReq {
    pub outlet_id: Option<Uuid>,
    pub direction: String,
    pub amount: i64,
    pub category: String,
    pub method: Option<String>,
    pub business_date: Option<String>,
    pub note: Option<String>,
    pub ref_type: Option<String>,
    pub ref_id: Option<Uuid>,
    pub op_id: Option<Uuid>,
}

/// POST /v1/cash-entries
pub async fn create(
    State(st): State<AppState>,
    ctx: AuthCtx,
    Json(body): Json<CashEntryReq>,
) -> ApiResult<Json<Value>> {
    ctx.require(Cap::CashWrite)?;
    if body.direction != "in" && body.direction != "out" {
        return Err(ApiError::validation_field(
            "Arah harus in atau out",
            "direction",
            "in | out",
        ));
    }
    if body.amount <= 0 {
        return Err(ApiError::validation_field(
            "Jumlah uang harus lebih dari 0",
            "amount",
            "min 1",
        ));
    }
    if body.category.trim().is_empty() {
        return Err(ApiError::validation_field(
            "Kategori wajib diisi",
            "category",
            "misal listrik",
        ));
    }
    let business_date = match &body.business_date {
        Some(s) => parse_date(s)?,
        None => today_jakarta(),
    };

    let mut tx = begin_tx(&st.pool, &ctx).await?;
    if let Some(op_id) = body.op_id {
        let dup: Option<Value> = sqlx::query_scalar("select result from op_log where op_id = $1")
            .bind(op_id)
            .fetch_optional(&mut *tx)
            .await?;
        if let Some(r) = dup {
            return Ok(Json(
                json!({ "duplicate": true, "op_id": op_id, "result": r }),
            ));
        }
    }
    let outlet_id = match body.outlet_id {
        Some(o) => o,
        None => crate::util::default_outlet_id(&mut tx).await?,
    };

    let id = now_v7();
    sqlx::query(
        "insert into cash_entry
           (id, tenant_id, outlet_id, direction, amount, category, method, ref_type, ref_id,
            business_date, note, op_id, created_by)
         values ($1, current_setting('app.tenant_id')::uuid, $2, $3, $4, $5, $6, $7, $8,
                 $9, $10, $11, $12)",
    )
    .bind(id)
    .bind(outlet_id)
    .bind(&body.direction)
    .bind(body.amount)
    .bind(body.category.trim())
    .bind(body.method.as_deref())
    .bind(body.ref_type.as_deref())
    .bind(body.ref_id)
    .bind(business_date)
    .bind(body.note.as_deref())
    .bind(body.op_id)
    .bind(ctx.user_id)
    .execute(&mut *tx)
    .await?;

    if let Some(op_id) = body.op_id {
        sqlx::query(
            "insert into op_log (op_id, tenant_id, result)
             values ($1, current_setting('app.tenant_id')::uuid, $2)",
        )
        .bind(op_id)
        .bind(json!({ "status": "applied", "endpoint": "cash_entry.create", "row_id": id }))
        .execute(&mut *tx)
        .await?;
    }

    let row = sqlx::query("select * from cash_entry where id = $1")
        .bind(id)
        .fetch_one(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(Json(entry_row_json(&row)?))
}

#[derive(Deserialize)]
pub struct CashListQuery {
    pub from: Option<String>,
    pub to: Option<String>,
    pub category: Option<String>,
    pub cursor: Option<Uuid>,
}

/// GET /v1/cash-entries?from=&to=&category=&cursor= — with period totals.
pub async fn list(
    State(st): State<AppState>,
    ctx: AuthCtx,
    Query(q): Query<CashListQuery>,
) -> ApiResult<Json<Value>> {
    let from = match &q.from {
        Some(s) => Some(parse_date(s)?),
        None => None,
    };
    let to = match &q.to {
        Some(s) => Some(parse_date(s)?),
        None => None,
    };
    let category = q
        .category
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty());

    let mut tx = begin_tx(&st.pool, &ctx).await?;
    let rows = sqlx::query(
        "select * from cash_entry
         where ($1::date is null or business_date >= $1)
           and ($2::date is null or business_date <= $2)
           and ($3::text is null or category = $3)
           and ($4::uuid is null or id < $4)
         order by id desc
         limit 101",
    )
    .bind(from)
    .bind(to)
    .bind(category)
    .bind(q.cursor)
    .fetch_all(&mut *tx)
    .await?;

    let totals: (Option<Decimal>, Option<Decimal>) = sqlx::query_as(
        "select sum(amount) filter (where direction = 'in'),
                sum(amount) filter (where direction = 'out')
         from cash_entry
         where ($1::date is null or business_date >= $1)
           and ($2::date is null or business_date <= $2)
           and ($3::text is null or category = $3)",
    )
    .bind(from)
    .bind(to)
    .bind(category)
    .fetch_one(&mut *tx)
    .await?;
    tx.commit().await?;

    let has_more = rows.len() > 100;
    let next_cursor = if has_more {
        rows.get(99)
            .map(|r| r.try_get::<Uuid, _>("id"))
            .transpose()?
    } else {
        None
    };
    let data = rows
        .into_iter()
        .take(100)
        .map(|r| entry_row_json(&r))
        .collect::<ApiResult<Vec<_>>>()?;

    // amounts are whole rupiah, so the rounded mantissa IS the value
    let in_total: i64 = totals
        .0
        .map(|d| i64::try_from(d.round().mantissa()).unwrap_or(0))
        .unwrap_or(0);
    let out_total: i64 = totals
        .1
        .map(|d| i64::try_from(d.round().mantissa()).unwrap_or(0))
        .unwrap_or(0);

    Ok(Json(json!({
        "data": data,
        "next_cursor": next_cursor,
        "totals": {
            "in": in_total,
            "out": out_total,
            "net": in_total - out_total,
        },
    })))
}

/// DELETE /v1/cash-entries/{id} — reversal entry, never a hard delete.
pub async fn reversal_delete(
    State(st): State<AppState>,
    ctx: AuthCtx,
    Path(id): Path<Uuid>,
) -> ApiResult<Json<Value>> {
    ctx.require(Cap::CashWrite)?;
    let mut tx = begin_tx(&st.pool, &ctx).await?;

    let orig = sqlx::query("select * from cash_entry where id = $1")
        .bind(id)
        .fetch_optional(&mut *tx)
        .await?;
    let orig = orig.ok_or_else(|| ApiError::NotFound("Catatan kas tidak ditemukan".into()))?;

    if orig.try_get::<Option<String>, _>("ref_type")?.as_deref() == Some("reversal") {
        return Err(ApiError::Conflict(
            "Pembalikan tidak bisa dibalik lagi".into(),
        ));
    }
    let reversed: i64 = sqlx::query_scalar(
        "select count(*) from cash_entry where ref_type = 'reversal' and ref_id = $1",
    )
    .bind(id)
    .fetch_one(&mut *tx)
    .await?;
    if reversed > 0 {
        return Err(ApiError::Conflict(
            "Catatan kas ini sudah dibatalkan".into(),
        ));
    }

    let direction = if orig.try_get::<String, _>("direction")? == "in" {
        "out"
    } else {
        "in"
    };
    let reversal_id = now_v7();
    sqlx::query(
        "insert into cash_entry
           (id, tenant_id, outlet_id, direction, amount, category, method, ref_type, ref_id,
            business_date, note, created_by)
         values ($1, current_setting('app.tenant_id')::uuid, $2, $3, $4, $5, $6, 'reversal', $7,
                 $8, $9, $10)",
    )
    .bind(reversal_id)
    .bind(orig.try_get::<Uuid, _>("outlet_id")?)
    .bind(direction)
    .bind(orig.try_get::<i64, _>("amount")?)
    .bind(orig.try_get::<String, _>("category")?)
    .bind(orig.try_get::<Option<String>, _>("method")?)
    .bind(id)
    .bind(orig.try_get::<NaiveDate, _>("business_date")?) // same period → net 0 there
    .bind("Pembalikan catatan kas")
    .bind(ctx.user_id)
    .execute(&mut *tx)
    .await?;

    let row = sqlx::query("select * from cash_entry where id = $1")
        .bind(reversal_id)
        .fetch_one(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(Json(entry_row_json(&row)?))
}

/// GET /v1/cash-categories — seeded + custom.
pub async fn categories(State(st): State<AppState>, ctx: AuthCtx) -> ApiResult<Json<Value>> {
    let mut tx = begin_tx(&st.pool, &ctx).await?;
    let rows: Vec<(Uuid, String, String, i32, bool)> = sqlx::query_as(
        "select id, name, direction, sort, seeded from cash_category order by sort, name",
    )
    .fetch_all(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(Json(json!({
        "data": rows.iter().map(|(id, name, dir, sort, seeded)| json!({
            "id": id, "name": name, "direction": dir, "sort": sort, "seeded": seeded
        })).collect::<Vec<_>>(),
        "next_cursor": null,
    })))
}
