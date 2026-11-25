use chrono::{DateTime, NaiveDate, Utc};
use rust_decimal::Decimal;
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::Row;
use uuid::Uuid;

use axum::extract::{Path, State};
use axum::Json;

use crate::ctx::{AuthCtx, Cap};
use crate::error::{ApiError, ApiResult};
use crate::state::AppState;
use crate::stock::{post_move, PostMove};
use crate::util::{begin_tx, now_v7, qty_json, today_jakarta};

struct SessionRow {
    id: Uuid,
    outlet_id: Uuid,
    status: String,
    category_id: Option<Uuid>,
    business_date: NaiveDate,
    posted_at: Option<DateTime<Utc>>,
    posted_by: Option<Uuid>,
    created_by: Option<Uuid>,
    created_at: DateTime<Utc>,
}

async fn load_session(tx: &mut sqlx::PgConnection, id: Uuid) -> ApiResult<SessionRow> {
    let row = sqlx::query(
        "select id, outlet_id, status, category_id, business_date, posted_at, posted_by,
                created_by, created_at
         from opname_session where id = $1",
    )
    .bind(id)
    .fetch_optional(tx)
    .await?;
    let row = row.ok_or_else(|| ApiError::NotFound("Sesi opname tidak ditemukan".into()))?;
    Ok(SessionRow {
        id: row.try_get("id")?,
        outlet_id: row.try_get("outlet_id")?,
        status: row.try_get("status")?,
        category_id: row.try_get("category_id")?,
        business_date: row.try_get("business_date")?,
        posted_at: row.try_get("posted_at")?,
        posted_by: row.try_get("posted_by")?,
        created_by: row.try_get("created_by")?,
        created_at: row.try_get("created_at")?,
    })
}

fn session_json(s: &SessionRow) -> Value {
    json!({
        "id": s.id,
        "outlet_id": s.outlet_id,
        "status": s.status,
        "category_id": s.category_id,
        "business_date": s.business_date,
        "posted_at": s.posted_at,
        "posted_by": s.posted_by,
        "created_by": s.created_by,
        "created_at": s.created_at,
    })
}

/// Lines with the snapshot `system_qty`, the entered `counted_qty`, and
/// the live stock right now (the post compares against the live number).
async fn lines_json(tx: &mut sqlx::PgConnection, session: &SessionRow) -> ApiResult<Vec<Value>> {
    let rows = sqlx::query(
        "select l.id, l.item_id, l.system_qty, l.counted_qty, l.counted_at, i.name as item_name,
                coalesce((select sl.qty from stock_level sl
                          where sl.item_id = l.item_id and sl.outlet_id = $2), 0) as current_qty
         from opname_line l
         join item i on i.id = l.item_id
         where l.session_id = $1
         order by i.name",
    )
    .bind(session.id)
    .bind(session.outlet_id)
    .fetch_all(tx)
    .await?;

    rows.iter()
        .map(|r| {
            let system_qty: Decimal = r.try_get("system_qty")?;
            let counted: Option<Decimal> = r.try_get("counted_qty")?;
            let current: Decimal = r.try_get("current_qty")?;
            Ok(json!({
                "id": r.try_get::<Uuid, _>("id")?,
                "item_id": r.try_get::<Uuid, _>("item_id")?,
                "item_name": r.try_get::<String, _>("item_name")?,
                "system_qty": qty_json(&system_qty),
                "counted_qty": counted.as_ref().map(qty_json),
                "counted_at": r.try_get::<Option<DateTime<Utc>>, _>("counted_at")?,
                "current_qty": qty_json(&current),
            }))
        })
        .collect()
}

#[derive(Deserialize)]
pub struct CreateOpnameReq {
    pub outlet_id: Option<Uuid>,
    pub category_id: Option<Uuid>,
    pub item_ids: Option<Vec<Uuid>>,
    pub business_date: Option<String>,
}

/// POST /v1/opname — session with one line per item, system_qty snapshot.
pub async fn create(
    State(st): State<AppState>,
    ctx: AuthCtx,
    Json(body): Json<CreateOpnameReq>,
) -> ApiResult<Json<Value>> {
    ctx.require(Cap::StockWrite)?;
    let business_date = match &body.business_date {
        Some(s) => crate::util::parse_date(s)?,
        None => today_jakarta(),
    };

    let mut tx = begin_tx(&st.pool, &ctx).await?;
    let outlet_id = match body.outlet_id {
        Some(o) => o,
        None => crate::util::default_outlet_id(&mut tx).await?,
    };

    // item selection: explicit ids > category > all non-deleted items
    let items: Vec<(Uuid, String)> = if let Some(ids) = &body.item_ids {
        if ids.is_empty() {
            return Err(ApiError::validation_field(
                "item_ids tidak boleh kosong",
                "item_ids",
                "minimal satu item",
            ));
        }
        let rows = sqlx::query(
            "select id, name from item where id = any($1) and deleted_at is null order by name",
        )
        .bind(ids)
        .fetch_all(&mut *tx)
        .await?;
        if rows.len() != ids.len() {
            return Err(ApiError::validation(
                "Ada item_id yang tidak ditemukan di toko ini",
            ));
        }
        rows.iter()
            .map(|r| Ok((r.try_get::<Uuid, _>("id")?, r.try_get::<String, _>("name")?)))
            .collect::<ApiResult<Vec<_>>>()?
    } else if let Some(cat) = body.category_id {
        let rows = sqlx::query(
            "select id, name from item where category_id = $1 and deleted_at is null order by name",
        )
        .bind(cat)
        .fetch_all(&mut *tx)
        .await?;
        rows.iter()
            .map(|r| Ok((r.try_get::<Uuid, _>("id")?, r.try_get::<String, _>("name")?)))
            .collect::<ApiResult<Vec<_>>>()?
    } else {
        let rows = sqlx::query("select id, name from item where deleted_at is null order by name")
            .fetch_all(&mut *tx)
            .await?;
        rows.iter()
            .map(|r| Ok((r.try_get::<Uuid, _>("id")?, r.try_get::<String, _>("name")?)))
            .collect::<ApiResult<Vec<_>>>()?
    };
    if items.is_empty() {
        return Err(ApiError::validation(
            "Tidak ada item untuk dihitung (kategori kosong atau item tidak ada)",
        ));
    }

    let session_id = now_v7();
    sqlx::query(
        "insert into opname_session
           (id, tenant_id, outlet_id, status, category_id, business_date, created_by)
         values ($1, current_setting('app.tenant_id')::uuid, $2, 'open', $3, $4, $5)",
    )
    .bind(session_id)
    .bind(outlet_id)
    .bind(body.category_id)
    .bind(business_date)
    .bind(ctx.user_id)
    .execute(&mut *tx)
    .await?;

    for (item_id, _name) in &items {
        let system_qty: Decimal = sqlx::query_scalar(
            "select coalesce((select sl.qty from stock_level sl
                              where sl.item_id = $1 and sl.outlet_id = $2), 0)",
        )
        .bind(item_id)
        .bind(outlet_id)
        .fetch_one(&mut *tx)
        .await?;
        sqlx::query(
            "insert into opname_line (id, tenant_id, session_id, item_id, system_qty)
             values ($1, current_setting('app.tenant_id')::uuid, $2, $3, $4)",
        )
        .bind(now_v7())
        .bind(session_id)
        .bind(item_id)
        .bind(system_qty)
        .execute(&mut *tx)
        .await?;
    }

    let session = load_session(&mut tx, session_id).await?;
    let lines = lines_json(&mut tx, &session).await?;
    tx.commit().await?;

    let mut v = session_json(&session);
    v["lines"] = Value::Array(lines);
    Ok(Json(v))
}

/// GET /v1/opname/{id} — session + counts (history kept forever).
pub async fn get_one(
    State(st): State<AppState>,
    ctx: AuthCtx,
    Path(id): Path<Uuid>,
) -> ApiResult<Json<Value>> {
    ctx.require(Cap::StockWrite)?;
    let mut tx = begin_tx(&st.pool, &ctx).await?;
    let session = load_session(&mut tx, id).await?;
    let lines = lines_json(&mut tx, &session).await?;
    tx.commit().await?;
    let mut v = session_json(&session);
    v["lines"] = Value::Array(lines);
    Ok(Json(v))
}

#[derive(Deserialize)]
pub struct PatchLinesReq {
    pub lines: Vec<PatchLine>,
}

#[derive(Deserialize)]
pub struct PatchLine {
    pub item_id: Uuid,
    #[serde(default, deserialize_with = "crate::util::de_qty_opt")]
    pub counted_qty: Option<Decimal>,
}

/// PATCH /v1/opname/{id}/lines — enter counts; only while open.
pub async fn patch_lines(
    State(st): State<AppState>,
    ctx: AuthCtx,
    Path(id): Path<Uuid>,
    Json(body): Json<PatchLinesReq>,
) -> ApiResult<Json<Value>> {
    ctx.require(Cap::StockWrite)?;
    if body.lines.is_empty() {
        return Err(ApiError::validation_field(
            "lines tidak boleh kosong",
            "lines",
            "minimal satu baris",
        ));
    }
    let mut tx = begin_tx(&st.pool, &ctx).await?;
    let session = load_session(&mut tx, id).await?;
    if session.status != "open" {
        return Err(ApiError::Conflict(format!(
            "Sesi opname ini sudah {}, hitungannya tidak bisa diubah",
            session.status
        )));
    }
    for line in &body.lines {
        let res = sqlx::query(
            "update opname_line set counted_qty = $3, counted_at = now()
             where session_id = $1 and item_id = $2",
        )
        .bind(id)
        .bind(line.item_id)
        .bind(line.counted_qty)
        .execute(&mut *tx)
        .await?;
        if res.rows_affected() == 0 {
            return Err(ApiError::validation(
                "Ada item yang tidak ada di sesi opname ini",
            ));
        }
    }
    let lines = lines_json(&mut tx, &session).await?;
    tx.commit().await?;
    let mut v = session_json(&session);
    v["lines"] = Value::Array(lines);
    Ok(Json(v))
}

/// POST /v1/opname/{id}/post — one adjust stock_move per non-zero
/// variance, in ONE transaction: all or nothing. Variance is counted_qty
/// minus the LIVE stock at post time (the snapshot stays history).
pub async fn post(
    State(st): State<AppState>,
    ctx: AuthCtx,
    Path(id): Path<Uuid>,
) -> ApiResult<Json<Value>> {
    ctx.require(Cap::StockWrite)?;
    let mut tx = begin_tx(&st.pool, &ctx).await?;
    let session = load_session(&mut tx, id).await?;
    if session.status != "open" {
        return Err(ApiError::Conflict(format!(
            "Sesi opname ini sudah {}, tidak bisa diposting ulang",
            session.status
        )));
    }

    // lines with a count, ordered for stable processing
    let rows = sqlx::query(
        "select l.item_id, l.counted_qty, i.cost_avg,
                coalesce((select sl.qty from stock_level sl
                          where sl.item_id = l.item_id
                            and sl.outlet_id = $2), 0) as current_qty
         from opname_line l
         join item i on i.id = l.item_id
         where l.session_id = $1 and l.counted_qty is not null
         order by l.item_id",
    )
    .bind(id)
    .bind(session.outlet_id)
    .fetch_all(&mut *tx)
    .await?;

    let mut adjustments: Vec<Value> = Vec::new();
    for r in &rows {
        let item_id: Uuid = r.try_get("item_id")?;
        let counted: Decimal = r.try_get("counted_qty")?;
        let current: Decimal = r.try_get("current_qty")?;
        let cost_avg: i64 = r.try_get("cost_avg")?;
        let variance = counted - current;
        if variance == Decimal::ZERO {
            continue;
        }
        let move_id = post_move(
            &mut tx,
            ctx.user_id,
            &PostMove {
                item_id,
                outlet_id: session.outlet_id,
                qty: variance,
                unit_cost: cost_avg,
                kind: "adjust",
                ref_type: Some("opname".into()),
                ref_id: Some(session.id),
                business_date: session.business_date,
                note: Some(format!("opname: hitung {counted} vs sistem {current}")),
                op_id: None,
            },
            None,
        )
        .await?;
        adjustments.push(json!({
            "item_id": item_id,
            "counted_qty": qty_json(&counted),
            "system_qty_at_post": qty_json(&current),
            "qty": qty_json(&variance),
            "move_id": move_id,
        }));
    }

    sqlx::query(
        "update opname_session set status = 'posted', posted_at = now(), posted_by = $2
         where id = $1",
    )
    .bind(id)
    .bind(ctx.user_id)
    .execute(&mut *tx)
    .await?;

    let session = load_session(&mut tx, id).await?;
    let lines = lines_json(&mut tx, &session).await?;
    tx.commit().await?;

    let mut sv = session_json(&session);
    sv["lines"] = Value::Array(lines);
    Ok(Json(json!({
        "posted": true,
        "adjustments": adjustments,
        "session": sv,
    })))
}
