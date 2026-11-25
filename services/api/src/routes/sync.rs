//! Sync endpoints (T-302/T-303) per docs/SYNC_INCREMENT.md.
//!
//! Push: one transaction per batch, ops ordered by client_ts then op_id;
//! op_log.op_id (primary key) gives exactly-once. A rejected op rolls back
//! to its savepoint and reports `rejected` — the batch continues.
//! Pull: change_log rows as `changes` with a server_seq cursor; soft
//! deletes come through as tombstones. Every op applies under the
//! caller's tenant via set_app_context, so RLS + roles hold unchanged.

use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::Row;
use uuid::Uuid;

use axum::extract::{Query, State};
use axum::Json;

use crate::ctx::AuthCtx;
use crate::error::{ApiError, ApiResult};
use crate::routes::cash::{apply_cash_entry, CashEntryReq};
use crate::routes::items::{apply_create_item, apply_update_item, CreateItemReq};
use crate::routes::opname::{apply_create_session, apply_opname_post, CreateOpnameReq};
use crate::routes::sales::{apply_sale, SaleReq};
use crate::state::AppState;
use crate::stock::{apply_stock_move, StockMoveReq};
use crate::util::begin_tx;

#[derive(Deserialize)]
pub struct PushReq {
    pub device_id: Option<Uuid>,
    pub ops: Vec<PushOp>,
}

#[derive(Deserialize)]
pub struct PushOp {
    pub op_id: Uuid,
    #[serde(rename = "type")]
    pub kind: String,
    pub payload: Value,
    pub client_ts: Option<String>,
}

fn op_reason(e: &ApiError) -> String {
    match e {
        ApiError::Validation { message, .. } => message.clone(),
        ApiError::Unauthorized(m)
        | ApiError::Forbidden(m)
        | ApiError::NotFound(m)
        | ApiError::Conflict(m)
        | ApiError::PeriodClosed(m) => m.clone(),
        ApiError::RateLimited => "Terlalu banyak percobaan".into(),
        ApiError::Internal(_) => "Kesalahan internal".into(),
    }
}

/// POST /v1/sync/push
pub async fn push(
    State(st): State<AppState>,
    ctx: AuthCtx,
    Json(body): Json<PushReq>,
) -> ApiResult<Json<Value>> {
    // any signed-in member can sync their own writes; capability checks
    // happen per op inside the apply functions (staff cannot item.*)
    if body.ops.len() > 50 {
        return Err(ApiError::validation_field(
            "Maksimal 50 op per batch",
            "ops",
            "max 50",
        ));
    }

    // order: client_ts then op_id (both optional/fall back to zero-ish)
    let mut ops = body.ops;
    ops.sort_by(|a, b| {
        let ta = a.client_ts.as_deref().unwrap_or("");
        let tb = b.client_ts.as_deref().unwrap_or("");
        (ta, a.op_id).cmp(&(tb, b.op_id))
    });

    let mut tx = begin_tx(&st.pool, &ctx).await?;

    let mut results: Vec<Value> = Vec::with_capacity(ops.len());
    for op in &ops {
        // exactly-once: op_log.op_id is the primary key
        let already: Option<Value> =
            sqlx::query_scalar("select result from op_log where op_id = $1")
                .bind(op.op_id)
                .fetch_optional(&mut *tx)
                .await?;
        if let Some(r) = already {
            results.push(json!({
                "op_id": op.op_id,
                "status": "duplicate",
                "reason": null,
                "result": r,
            }));
            continue;
        }

        // apply on a savepoint: a rejection must not abort the batch
        sqlx::query("savepoint op").execute(&mut *tx).await?;
        match apply_op(&mut tx, &ctx, op).await {
            Ok(row_id) => {
                let insert = sqlx::query(
                    "insert into op_log (op_id, tenant_id, device_id, result)
                     values ($1, current_setting('app.tenant_id')::uuid, $2, $3)",
                )
                .bind(op.op_id)
                .bind(body.device_id)
                .bind(json!({ "status": "applied", "row_id": row_id }))
                .execute(&mut *tx)
                .await;
                match insert {
                    Ok(_) => {
                        sqlx::query("release savepoint op")
                            .execute(&mut *tx)
                            .await?;
                        results.push(json!({
                            "op_id": op.op_id,
                            "status": "applied",
                            "reason": null,
                        }));
                    }
                    Err(e) => {
                        // op_log.op_id is a GLOBAL primary key: a collision
                        // with another tenant's op_id is still exactly-once —
                        // no second effect ever happens. Undo this op and
                        // report duplicate; no other tenant's data is
                        // returned.
                        let unique = matches!(&e, sqlx::Error::Database(db)
                            if db.code().as_deref() == Some("23505"));
                        sqlx::query("rollback to savepoint op")
                            .execute(&mut *tx)
                            .await?;
                        if unique {
                            results.push(json!({
                                "op_id": op.op_id,
                                "status": "duplicate",
                                "reason": null,
                            }));
                        } else {
                            return Err(ApiError::Internal(format!("{e:#}")));
                        }
                    }
                }
            }
            Err(e) => {
                sqlx::query("rollback to savepoint op")
                    .execute(&mut *tx)
                    .await?;
                results.push(json!({
                    "op_id": op.op_id,
                    "status": "rejected",
                    "reason": op_reason(&e),
                }));
            }
        }
    }

    let cursor: i64 = sqlx::query_scalar(
        "select coalesce(max(server_seq), 0) from change_log where tenant_id = $1",
    )
    .bind(ctx.tenant_id)
    .fetch_one(&mut *tx)
    .await?;

    tx.commit().await?;

    Ok(Json(json!({ "results": results, "cursor": cursor })))
}

async fn apply_op(tx: &mut sqlx::PgConnection, ctx: &AuthCtx, op: &PushOp) -> ApiResult<Uuid> {
    // every apply_* is the SAME engine the REST handlers use
    let row_id: Uuid = match op.kind.as_str() {
        "stock_move.create" => {
            let mut req: StockMoveReq = serde_json::from_value(op.payload.clone())
                .map_err(|e| ApiError::validation(format!("Payload tidak valid: {e}")))?;
            req.op_id = Some(op.op_id);
            let v = apply_stock_move(&mut *tx, ctx, &req).await?;
            serde_json::from_value(v["id"].clone()).unwrap_or(op.op_id)
        }
        "sale.create" => {
            let mut req: SaleReq = serde_json::from_value(op.payload.clone())
                .map_err(|e| ApiError::validation(format!("Payload tidak valid: {e}")))?;
            req.op_id = Some(op.op_id);
            let v = apply_sale(tx, ctx, &req).await?;
            serde_json::from_value(v["id"].clone()).unwrap_or(op.op_id)
        }
        "cash_entry.create" => {
            let mut req: CashEntryReq = serde_json::from_value(op.payload.clone())
                .map_err(|e| ApiError::validation(format!("Payload tidak valid: {e}")))?;
            req.op_id = Some(op.op_id);
            let v = apply_cash_entry(tx, ctx, &req).await?;
            serde_json::from_value(v["id"].clone()).unwrap_or(op.op_id)
        }
        "item.create" => {
            let mut req: CreateItemReq = serde_json::from_value(op.payload.clone())
                .map_err(|e| ApiError::validation(format!("Payload tidak valid: {e}")))?;
            req.op_id = Some(op.op_id);
            let v = apply_create_item(tx, ctx, &req).await?;
            serde_json::from_value(v["id"].clone()).unwrap_or(op.op_id)
        }
        "item.update" => {
            // payload: { item_id, ...fields }
            let mut p = op.payload.clone();
            let item_id: Uuid = serde_json::from_value(p["item_id"].clone()).map_err(|_| {
                ApiError::validation_field("item_id wajib diisi", "item_id", "uuid")
            })?;
            p.as_object_mut().map(|m| m.remove("item_id"));
            let v = apply_update_item(tx, ctx, item_id, &p).await?;
            serde_json::from_value(v["id"].clone()).unwrap_or(item_id)
        }
        "opname.post" => {
            // payload for sync: the whole flow — create session with lines,
            // then post. { outlet_id?, category_id?|item_ids?, business_date?,
            //   lines: [{item_id, counted_qty}] }
            let p: OpnameSyncPayload = serde_json::from_value(op.payload.clone())
                .map_err(|e| ApiError::validation(format!("Payload tidak valid: {e}")))?;
            let mut req = CreateOpnameReq {
                outlet_id: p.outlet_id,
                category_id: p.category_id,
                item_ids: p.item_ids,
                business_date: p.business_date.clone(),
            };
            if req.item_ids.is_none() && req.category_id.is_none() {
                // derive from lines when the client sends neither selector
                let ids: Vec<Uuid> = p.lines.iter().map(|l| l.item_id).collect();
                if !ids.is_empty() {
                    req.item_ids = Some(ids);
                }
            }
            // empty selection = all items; keep that behavior if no filter
            let sess = apply_create_session(tx, ctx, &req).await?;
            let session_id: Uuid = serde_json::from_value(sess["id"].clone()).unwrap_or(op.op_id);

            // enter counts on a fresh copy (session create is the shared path)
            if !p.lines.is_empty() {
                let patch_req = crate::routes::opname::PatchLinesReq {
                    lines: p
                        .lines
                        .iter()
                        .map(|l| crate::routes::opname::PatchLine {
                            item_id: l.item_id,
                            counted_qty: Some(l.counted_qty),
                        })
                        .collect(),
                };
                crate::routes::opname::apply_patch_lines(&mut *tx, ctx, session_id, &patch_req)
                    .await?;
            }
            apply_opname_post(&mut *tx, ctx, session_id).await?;
            session_id
        }
        other => {
            return Err(ApiError::validation(format!(
                "Tipe op tidak dikenal: {other}"
            )))
        }
    };
    Ok(row_id)
}

#[derive(Deserialize)]
struct OpnameSyncPayload {
    outlet_id: Option<Uuid>,
    category_id: Option<Uuid>,
    item_ids: Option<Vec<Uuid>>,
    business_date: Option<String>,
    #[serde(default)]
    lines: Vec<OpnameSyncLine>,
}

#[derive(Deserialize)]
struct OpnameSyncLine {
    item_id: Uuid,
    #[serde(deserialize_with = "crate::util::de_qty")]
    counted_qty: rust_decimal::Decimal,
}

#[derive(Deserialize)]
pub struct PullQuery {
    pub cursor: Option<i64>,
    pub limit: Option<i64>,
}

/// GET /v1/sync/pull?cursor=&limit= — change_log with the full row and a
/// deleted flag; soft-deleted items pull as tombstones.
pub async fn pull(
    State(st): State<AppState>,
    ctx: AuthCtx,
    Query(q): Query<PullQuery>,
) -> ApiResult<Json<Value>> {
    let cursor = q.cursor.unwrap_or(0).max(0);
    let limit = q.limit.unwrap_or(500).clamp(1, 500);

    let mut tx = begin_tx(&st.pool, &ctx).await?;

    let rows = sqlx::query(
        "select server_seq, table_name, row_id, op, changed_at
         from change_log
         where tenant_id = current_setting('app.tenant_id')::uuid
           and server_seq > $1
         order by server_seq
         limit $2 + 1",
    )
    .bind(cursor)
    .bind(limit)
    .fetch_all(&mut *tx)
    .await?;

    let has_more = rows.len() as i64 > limit;
    let rows = &rows[..rows
        .len()
        .saturating_sub(usize::try_from(has_more as i64).unwrap_or(0))];

    let mut changes: Vec<Value> = Vec::new();
    let mut last_seq = cursor;
    for r in rows {
        let seq: i64 = r.try_get("server_seq")?;
        let table: String = r.try_get("table_name")?;
        let row_id: Option<Uuid> = r.try_get("row_id")?;
        let op: String = r.try_get("op")?;
        last_seq = seq;

        // fetch the row through RLS in the caller's tenant context
        let (row, deleted) = fetch_row(&mut tx, &table, row_id).await?;
        changes.push(json!({
            "table": table,
            "row": row,
            "server_seq": seq,
            "op": op,
            "deleted": deleted,
        }));
    }

    tx.commit().await?;

    Ok(Json(json!({
        "changes": changes,
        "cursor": last_seq,
        "has_more": has_more,
    })))
}

/// One query per change row, through the tenant's RLS policies. Soft
/// deletes derive from the row itself (deleted_at not null ⇒ tombstone).
async fn fetch_row(
    tx: &mut sqlx::PgConnection,
    table: &str,
    row_id: Option<Uuid>,
) -> ApiResult<(Value, bool)> {
    use sqlx::postgres::PgRow;
    let Some(id) = row_id else {
        return Ok((Value::Null, false));
    };
    let row: Option<PgRow> = match table {
        "item" => sqlx::query("select to_jsonb(i) as row, (i.deleted_at is not null) as deleted from item i where i.id = $1").bind(id).fetch_optional(tx).await?,
        "category" => sqlx::query("select to_jsonb(c) as row, false as deleted from category c where c.id = $1").bind(id).fetch_optional(tx).await?,
        "item_barcode" => sqlx::query("select to_jsonb(b) as row, false as deleted from item_barcode b where b.id = $1").bind(id).fetch_optional(tx).await?,
        "item_unit" => sqlx::query("select to_jsonb(u) as row, false as deleted from item_unit u where u.id = $1").bind(id).fetch_optional(tx).await?,
        "stock_move" => sqlx::query("select to_jsonb(m) as row, false as deleted from stock_move m where m.id = $1").bind(id).fetch_optional(tx).await?,
        "stock_level" => sqlx::query("select to_jsonb(s) as row, false as deleted from stock_level s where s.item_id = $1").bind(id).fetch_optional(tx).await?,
        "sale" => sqlx::query("select to_jsonb(s) as row, (s.voided_at is not null) as voided, false as deleted from sale s where s.id = $1").bind(id).fetch_optional(tx).await?,
        "payment" => sqlx::query("select to_jsonb(p) as row, false as deleted from payment p where p.id = $1").bind(id).fetch_optional(tx).await?,
        "cash_entry" => sqlx::query("select to_jsonb(c) as row, false as deleted from cash_entry c where c.id = $1").bind(id).fetch_optional(tx).await?,
        "cash_category" => sqlx::query("select to_jsonb(c) as row, false as deleted from cash_category c where c.id = $1").bind(id).fetch_optional(tx).await?,
        "contact" => sqlx::query("select to_jsonb(c) as row, false as deleted from contact c where c.id = $1").bind(id).fetch_optional(tx).await?,
        "opname_session" => sqlx::query("select to_jsonb(o) as row, false as deleted from opname_session o where o.id = $1").bind(id).fetch_optional(tx).await?,
        "outlet" => sqlx::query("select to_jsonb(o) as row, false as deleted from outlet o where o.id = $1").bind(id).fetch_optional(tx).await?,
        "tenant" => sqlx::query("select to_jsonb(t) as row, false as deleted from tenant t where t.id = $1").bind(id).fetch_optional(tx).await?,
        "membership" => sqlx::query("select to_jsonb(m) as row, false as deleted from membership m where m.id = $1").bind(id).fetch_optional(tx).await?,
        "receivable" => sqlx::query("select to_jsonb(r) as row, false as deleted from receivable r where r.id = $1").bind(id).fetch_optional(tx).await?,
        "payable" => sqlx::query("select to_jsonb(p) as row, false as deleted from payable p where p.id = $1").bind(id).fetch_optional(tx).await?,
        "period_lock" => sqlx::query("select to_jsonb(p) as row, false as deleted from period_lock p where p.tenant_id = $1").bind(id).fetch_optional(tx).await?,
        _ => None,
    };
    let Some(row) = row else {
        // vanished rows (RLS/cleanup) still advance the cursor as a no-op
        return Ok((Value::Null, false));
    };
    let row_v: Value = row.try_get::<sqlx::types::Json<Value>, _>("row")?.0;
    let deleted: bool = row.try_get("deleted")?;
    Ok((row_v, deleted))
}
