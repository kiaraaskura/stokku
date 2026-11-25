use chrono::NaiveDate;
use rust_decimal::Decimal;
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::{PgConnection, Row};
use uuid::Uuid;

use axum::extract::State;
use axum::Json;

use crate::ctx::{AuthCtx, Cap};
use crate::error::{ApiError, ApiResult};
use crate::state::AppState;
use crate::util::{begin_tx, now_v7, qty_json, today_jakarta};

/// A signed ledger entry to append. Sale moves are created by
/// `/sales` (and void), never by the client directly.
#[derive(Debug, Clone)]
pub struct PostMove {
    pub item_id: Uuid,
    pub outlet_id: Uuid,
    pub qty: Decimal, // signed delta, never zero
    pub unit_cost: i64,
    pub kind: &'static str, // in | sale | loss | return | adjust
    pub ref_type: Option<String>,
    pub ref_id: Option<Uuid>,
    pub business_date: NaiveDate,
    pub note: Option<String>,
    pub op_id: Option<Uuid>,
}

/// Milli-units (qty × 1000) as i128 for exact integer math.
fn dec_milli(d: Decimal) -> i128 {
    let mut m: i128 = d.mantissa();
    let scale = d.scale();
    if scale < 3 {
        m *= 10_i128.pow(3 - scale);
    }
    m
}

fn div_round(num: i128, den: i128) -> i128 {
    debug_assert!(den != 0);
    if num >= 0 {
        (num * 2 + den) / (2 * den)
    } else {
        (num * 2 - den) / (2 * den)
    }
}

/// Moving weighted average after a purchase (`type=in`).
/// With non-positive stock the incoming cost simply becomes the average.
pub fn avg_after_in(old_qty: Decimal, old_avg: i64, add_qty: Decimal, unit_cost: i64) -> i64 {
    if old_qty <= Decimal::ZERO || add_qty <= Decimal::ZERO {
        return unit_cost.max(0);
    }
    let num = dec_milli(old_qty) * i128::from(old_avg) + dec_milli(add_qty) * i128::from(unit_cost);
    let den = dec_milli(old_qty) + dec_milli(add_qty);
    if den == 0 {
        return old_avg;
    }
    let avg = div_round(num, den);
    avg.clamp(0, i128::from(i64::MAX)) as i64
}

/// Moving average after removing a purchase (reversal of `type=in`).
/// Returns `None` when the average should stay as is (stock emptied or
/// would go non-positive). Value-pool method: (qty×avg − rm×cost) / (qty−rm).
pub fn avg_after_removing(
    old_qty: Decimal,
    old_avg: i64,
    rm_qty: Decimal,
    rm_cost: i64,
) -> Option<i64> {
    let new_qty = old_qty - rm_qty;
    if new_qty <= Decimal::ZERO || rm_qty <= Decimal::ZERO {
        return None;
    }
    let num = dec_milli(old_qty) * i128::from(old_avg) - dec_milli(rm_qty) * i128::from(rm_cost);
    let den = dec_milli(new_qty);
    if den == 0 {
        return None;
    }
    let avg = div_round(num, den);
    Some(avg.clamp(0, i128::from(i64::MAX)) as i64)
}

/// Total stock of an item across outlets (moving average is item-level).
pub async fn total_qty(tx: &mut PgConnection, item_id: Uuid) -> Decimal {
    sqlx::query_scalar::<_, Decimal>(
        "select coalesce(sum(qty), 0) from stock_level where item_id = $1",
    )
    .bind(item_id)
    .fetch_one(&mut *tx)
    .await
    .unwrap_or(Decimal::ZERO)
}

pub async fn item_cost_avg(tx: &mut PgConnection, item_id: Uuid) -> ApiResult<i64> {
    let avg: Option<i64> = sqlx::query_scalar("select cost_avg from item where id = $1")
        .bind(item_id)
        .fetch_optional(&mut *tx)
        .await?;
    avg.ok_or_else(|| ApiError::NotFound("Item tidak ditemukan".into()))
}

/// The posting engine: append one `stock_move`, update the
/// `stock_level` projection, optionally update `item.cost_avg`.
/// Never edits or deletes an existing move.
pub async fn post_move(
    tx: &mut PgConnection,
    actor: Uuid,
    p: &PostMove,
    new_avg: Option<i64>,
) -> ApiResult<Uuid> {
    if p.qty == Decimal::ZERO {
        return Err(ApiError::validation("Qty tidak boleh 0"));
    }
    let id = now_v7();
    sqlx::query(
        "insert into stock_move
           (id, tenant_id, outlet_id, item_id, qty, unit_cost, type, ref_type, ref_id,
            business_date, note, created_by, op_id)
         values ($1, current_setting('app.tenant_id')::uuid, $2, $3, $4, $5, $6, $7, $8,
                 $9, $10, $11, $12)",
    )
    .bind(id)
    .bind(p.outlet_id)
    .bind(p.item_id)
    .bind(p.qty)
    .bind(p.unit_cost)
    .bind(p.kind)
    .bind(p.ref_type.as_deref())
    .bind(p.ref_id)
    .bind(p.business_date)
    .bind(p.note.as_deref())
    .bind(actor)
    .bind(p.op_id)
    .execute(&mut *tx)
    .await?;

    sqlx::query(
        "insert into stock_level (tenant_id, outlet_id, item_id, qty)
         values (current_setting('app.tenant_id')::uuid, $1, $2, $3)
         on conflict (outlet_id, item_id)
         do update set qty = stock_level.qty + excluded.qty",
    )
    .bind(p.outlet_id)
    .bind(p.item_id)
    .bind(p.qty)
    .execute(&mut *tx)
    .await?;

    if let Some(avg) = new_avg {
        sqlx::query("update item set cost_avg = $2 where id = $1")
            .bind(p.item_id)
            .bind(avg)
            .execute(&mut *tx)
            .await?;
    }

    Ok(id)
}

fn move_row_json(row: &sqlx::postgres::PgRow, include_cost: bool) -> ApiResult<Value> {
    let qty: Decimal = row.try_get("qty")?;
    let unit_cost: Option<i64> = row.try_get("unit_cost").ok();
    let mut v = json!({
        "id": row.try_get::<Uuid, _>("id")?,
        "item_id": row.try_get::<Uuid, _>("item_id")?,
        "outlet_id": row.try_get::<Uuid, _>("outlet_id")?,
        "qty": qty_json(&qty),
        "type": row.try_get::<String, _>("type")?,
        "ref_type": row.try_get::<Option<String>, _>("ref_type")?,
        "ref_id": row.try_get::<Option<Uuid>, _>("ref_id")?,
        "business_date": row.try_get::<NaiveDate, _>("business_date")?,
        "note": row.try_get::<Option<String>, _>("note")?,
        "created_by": row.try_get::<Option<Uuid>, _>("created_by")?,
        "created_at": row.try_get::<chrono::DateTime<chrono::Utc>, _>("created_at")?,
        "op_id": row.try_get::<Option<Uuid>, _>("op_id")?,
    });
    if include_cost {
        v["unit_cost"] = json!(unit_cost.unwrap_or(0));
    }
    Ok(v)
}

#[derive(Deserialize)]
pub struct StockMoveReq {
    pub item_id: Uuid,
    pub outlet_id: Option<Uuid>,
    pub r#type: String,
    #[serde(deserialize_with = "crate::util::de_qty")]
    pub qty_positive: Decimal,
    pub unit_cost: Option<i64>,
    pub business_date: Option<String>,
    pub supplier: Option<String>,
    pub note: Option<String>,
    pub op_id: Option<Uuid>,
}

/// POST /v1/stock-moves
pub async fn create(
    State(st): State<AppState>,
    ctx: AuthCtx,
    Json(body): Json<StockMoveReq>,
) -> ApiResult<Json<Value>> {
    ctx.require(Cap::StockWrite)?;
    let mut tx = begin_tx(&st.pool, &ctx).await?;
    if let Some(op_id) = body.op_id {
        if let Some(dup) = check_op_duplicate(&mut tx, op_id).await? {
            return Ok(Json(dup));
        }
    }
    let v = apply_stock_move(&mut tx, &ctx, &body).await?;
    if let Some(op_id) = body.op_id {
        let row_id: Uuid = serde_json::from_value(v["id"].clone()).unwrap_or(op_id);
        record_op_log(&mut tx, Some(op_id), "stock_move.create", row_id).await?;
    }
    tx.commit().await?;
    Ok(Json(v))
}

/// The single stock-move posting path, shared by the REST handler and
/// sync push (one ledger, one engine — never a fork).
pub async fn apply_stock_move(
    tx: &mut PgConnection,
    ctx: &AuthCtx,
    body: &StockMoveReq,
) -> ApiResult<Value> {
    ctx.require(Cap::StockWrite)?;
    let kind: &'static str = match body.r#type.as_str() {
        "in" => "in",
        "loss" => "loss",
        "return" => "return",
        "adjust" => "adjust",
        other => {
            return Err(ApiError::validation_field(
                format!("Tipe tidak valid: {other}"),
                "type",
                "in | loss | return | adjust",
            ))
        }
    };
    if body.qty_positive <= Decimal::ZERO {
        return Err(ApiError::validation_field(
            "Qty harus lebih dari 0",
            "qty_positive",
            "min 0.001",
        ));
    }
    let unit_cost = body.unit_cost.unwrap_or(0).max(0);
    let business_date = match &body.business_date {
        Some(s) => crate::util::parse_date(s)?,
        None => today_jakarta(),
    };

    let outlet_id = match body.outlet_id {
        Some(o) => o,
        None => crate::util::default_outlet_id(&mut *tx).await?,
    };

    let old_avg = item_cost_avg(&mut *tx, body.item_id).await?;
    let old_qty = total_qty(&mut *tx, body.item_id).await;

    // Direction by type: purchases and customer returns add stock,
    // loss/adjustment reduce it (opname covers both signs later).
    let qty = if kind == "in" || kind == "return" {
        body.qty_positive
    } else {
        -body.qty_positive
    };

    let new_avg = if kind == "in" && qty > Decimal::ZERO {
        Some(avg_after_in(old_qty, old_avg, qty, unit_cost))
    } else {
        None
    };
    let recorded_cost = if kind == "in" { unit_cost } else { old_avg };

    let note = match &body.supplier {
        Some(s) if !s.trim().is_empty() => match &body.note {
            Some(n) => Some(format!("pemasok: {s}; {n}")),
            None => Some(format!("pemasok: {s}")),
        },
        _ => body.note.clone(),
    };

    let move_id = post_move(
        &mut *tx,
        ctx.user_id,
        &PostMove {
            item_id: body.item_id,
            outlet_id,
            qty,
            unit_cost: recorded_cost,
            kind,
            ref_type: None,
            ref_id: None,
            business_date,
            note,
            op_id: body.op_id,
        },
        new_avg,
    )
    .await?;

    let row = sqlx::query("select * from stock_move where id = $1")
        .bind(move_id)
        .fetch_one(tx)
        .await?;
    move_row_json(&row, ctx.can_read_cost())
}

async fn check_op_duplicate(tx: &mut PgConnection, op_id: Uuid) -> ApiResult<Option<Value>> {
    let existing: Option<Value> = sqlx::query_scalar("select result from op_log where op_id = $1")
        .bind(op_id)
        .fetch_optional(&mut *tx)
        .await?;
    Ok(existing.map(|r| json!({ "duplicate": true, "op_id": op_id, "result": r })))
}

async fn record_op_log(
    tx: &mut PgConnection,
    op_id: Option<Uuid>,
    endpoint: &str,
    row_id: Uuid,
) -> ApiResult<()> {
    let Some(op_id) = op_id else { return Ok(()) };
    sqlx::query(
        "insert into op_log (op_id, tenant_id, result) values ($1, current_setting('app.tenant_id')::uuid, $2)",
    )
    .bind(op_id)
    .bind(json!({ "status": "applied", "endpoint": endpoint, "row_id": row_id }))
    .execute(&mut *tx)
    .await?;
    Ok(())
}

#[derive(Deserialize)]
pub struct MoveListQuery {
    pub item_id: Option<Uuid>,
    pub outlet_id: Option<Uuid>,
    pub from: Option<String>,
    pub to: Option<String>,
    pub cursor: Option<Uuid>,
}

/// GET /v1/stock-moves — 100/page, newest first.
pub async fn list(
    State(st): State<AppState>,
    ctx: AuthCtx,
    axum::extract::Query(q): axum::extract::Query<MoveListQuery>,
) -> ApiResult<Json<Value>> {
    let from = match &q.from {
        Some(s) => Some(crate::util::parse_date(s)?),
        None => None,
    };
    let to = match &q.to {
        Some(s) => Some(crate::util::parse_date(s)?),
        None => None,
    };

    let mut tx = begin_tx(&st.pool, &ctx).await?;
    let rows = sqlx::query(
        "select * from stock_move
         where ($1::uuid is null or item_id = $1)
           and ($2::uuid is null or outlet_id = $2)
           and ($3::date is null or business_date >= $3)
           and ($4::date is null or business_date <= $4)
           and ($5::uuid is null or id < $5)
         order by id desc
         limit 101",
    )
    .bind(q.item_id)
    .bind(q.outlet_id)
    .bind(from)
    .bind(to)
    .bind(q.cursor)
    .fetch_all(&mut *tx)
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
        .map(|r| move_row_json(&r, ctx.can_read_cost()))
        .collect::<ApiResult<Vec<_>>>()?;

    Ok(Json(json!({ "data": data, "next_cursor": next_cursor })))
}

struct MoveRowFull {
    id: Uuid,
    item_id: Uuid,
    outlet_id: Uuid,
    qty: Decimal,
    unit_cost: i64,
    kind: String,
    business_date: NaiveDate,
}

async fn load_move(tx: &mut PgConnection, id: Uuid) -> ApiResult<MoveRowFull> {
    let row = sqlx::query(
        "select id, item_id, outlet_id, qty, unit_cost, type, business_date
         from stock_move where id = $1",
    )
    .bind(id)
    .fetch_optional(&mut *tx)
    .await?;
    let row = row.ok_or_else(|| ApiError::NotFound("Pergerakan stok tidak ditemukan".into()))?;
    Ok(MoveRowFull {
        id: row.try_get("id")?,
        item_id: row.try_get("item_id")?,
        outlet_id: row.try_get("outlet_id")?,
        qty: row.try_get("qty")?,
        unit_cost: row.try_get("unit_cost")?,
        kind: row.try_get("type")?,
        business_date: row.try_get("business_date")?,
    })
}

async fn already_reversed(tx: &mut PgConnection, id: Uuid) -> ApiResult<bool> {
    let n: i64 = sqlx::query_scalar(
        "select count(*) from stock_move where ref_type = 'reversal' and ref_id = $1",
    )
    .bind(id)
    .fetch_one(&mut *tx)
    .await?;
    Ok(n > 0)
}

/// Compute the counter-entry for a reversal: opposite qty, same
/// unit_cost, and the moving-average impact of removing an 'in'.
struct ReversalPlan {
    pm: PostMove,
    new_avg: Option<i64>,
    old_avg: i64,
}

async fn reversal_plan(tx: &mut PgConnection, orig: &MoveRowFull) -> ApiResult<ReversalPlan> {
    let cur_avg = item_cost_avg(tx, orig.item_id).await?;
    let cur_qty = total_qty(tx, orig.item_id).await;
    let new_avg = if orig.kind == "in" && orig.qty > Decimal::ZERO {
        avg_after_removing(cur_qty, cur_avg, orig.qty, orig.unit_cost).filter(|n| *n != cur_avg)
    } else {
        None
    };
    let pm = PostMove {
        item_id: orig.item_id,
        outlet_id: orig.outlet_id,
        qty: -orig.qty,
        unit_cost: orig.unit_cost,
        kind: "adjust", // counter-entry; the original is referenced in ref
        ref_type: Some("reversal".into()),
        ref_id: Some(orig.id),
        business_date: orig.business_date,
        note: None,
        op_id: None,
    };
    Ok(ReversalPlan {
        pm,
        new_avg,
        old_avg: cur_avg,
    })
}

#[derive(Deserialize)]
pub struct ReverseReq {
    pub reason: String,
    pub business_date: Option<String>,
    pub op_id: Option<Uuid>,
}

fn cost_warning(old: i64, new: i64) -> String {
    format!("Cost rata-rata item berubah dari {old} ke {new} setelah pembalikan ini")
}

/// POST /v1/stock-moves/preview-reverse/{id}
pub async fn preview_reverse(
    State(st): State<AppState>,
    ctx: AuthCtx,
    axum::extract::Path(id): axum::extract::Path<Uuid>,
) -> ApiResult<Json<Value>> {
    ctx.require(Cap::StockWrite)?;
    let mut tx = begin_tx(&st.pool, &ctx).await?;
    let orig = load_move(&mut tx, id).await?;
    if already_reversed(&mut tx, id).await? {
        return Err(ApiError::Conflict("Pergerakan ini sudah dibalik".into()));
    }
    let plan = reversal_plan(&mut tx, &orig).await?;
    let mut v = json!({
        "would_create": {
            "item_id": plan.pm.item_id,
            "outlet_id": plan.pm.outlet_id,
            "qty": qty_json(&plan.pm.qty),
            "type": plan.pm.kind,
            "ref_type": "reversal",
            "ref_id": orig.id,
        }
    });
    if ctx.can_read_cost() {
        if let Some(new) = plan.new_avg {
            v["cost_impact_warning"] = json!(cost_warning(plan.old_avg, new));
        }
    }
    Ok(Json(v))
}

/// POST /v1/stock-moves/{id}/reverse — append a counter-entry; never edit.
pub async fn reverse(
    State(st): State<AppState>,
    ctx: AuthCtx,
    axum::extract::Path(id): axum::extract::Path<Uuid>,
    Json(body): Json<ReverseReq>,
) -> ApiResult<Json<Value>> {
    ctx.require(Cap::StockWrite)?;
    if body.reason.trim().is_empty() {
        return Err(ApiError::validation_field(
            "Alasan wajib diisi",
            "reason",
            "tidak boleh kosong",
        ));
    }
    let business_date = match &body.business_date {
        Some(s) => crate::util::parse_date(s)?,
        None => today_jakarta(),
    };

    let mut tx = begin_tx(&st.pool, &ctx).await?;
    if let Some(op_id) = body.op_id {
        if let Some(dup) = check_op_duplicate(&mut tx, op_id).await? {
            return Ok(Json(dup));
        }
    }
    let orig = load_move(&mut tx, id).await?;
    if already_reversed(&mut tx, id).await? {
        return Err(ApiError::Conflict("Pergerakan ini sudah dibalik".into()));
    }
    let mut plan = reversal_plan(&mut tx, &orig).await?;
    plan.pm.business_date = business_date;
    plan.pm.note = Some(body.reason.trim().to_string());
    plan.pm.op_id = body.op_id;

    let move_id = post_move(&mut tx, ctx.user_id, &plan.pm, plan.new_avg).await?;
    record_op_log(&mut tx, body.op_id, "stock_move.reverse", move_id).await?;

    let row = sqlx::query("select * from stock_move where id = $1")
        .bind(move_id)
        .fetch_one(&mut *tx)
        .await?;
    tx.commit().await?;

    let mut v = move_row_json(&row, ctx.can_read_cost())?;
    if ctx.can_read_cost() {
        if let Some(new) = plan.new_avg {
            v["cost_impact_warning"] = json!(cost_warning(plan.old_avg, new));
        }
    }
    Ok(Json(v))
}
