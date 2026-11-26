//! Bulk item import (T-112) and the stock reconcile check (T-126).
//!
//! Import is deliberately boring: a header row, a per-row savepoint, and a
//! per-row error list. A bad row is reported and skipped; it never aborts the
//! rows around it, and `dry_run=true` writes nothing at all.
//!
//! Reconcile compares `stock_level` against the sum of `stock_move` deltas per
//! item. A mismatch is a bug, so this only reports — it never repairs.

use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::Row;

use axum::extract::{Query, State};
use axum::http::header;
use axum::response::IntoResponse;
use axum::Json;

use crate::ctx::{AuthCtx, Cap};
use crate::error::{ApiError, ApiResult};
use crate::routes::items::{apply_create_item, CreateItemReq};
use crate::state::AppState;
use crate::util::begin_tx;

#[derive(Deserialize)]
pub struct ImportQuery {
    #[serde(default)]
    pub dry_run: bool,
}

/// Split one CSV line into fields, honouring double quotes and `""` escapes.
/// Indonesian shop exports often contain a comma inside the item name, so a
/// plain `split(',')` is not good enough.
fn split_csv_line(line: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut field = String::new();
    let mut in_quotes = false;
    let mut chars = line.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '"' if in_quotes => {
                if chars.peek() == Some(&'"') {
                    chars.next();
                    field.push('"');
                } else {
                    in_quotes = false;
                }
            }
            '"' if field.trim().is_empty() && !in_quotes => {
                in_quotes = true;
                field.clear();
            }
            ',' if !in_quotes => {
                out.push(field.trim().to_string());
                field.clear();
            }
            _ => field.push(c),
        }
    }
    out.push(field.trim().to_string());
    out
}

/// POST /v1/items/import?dry_run=true — CSV body.
///
/// Header (case-insensitive, any order): `name,sku,base_unit,sale_price,cost,
/// min_stock,barcode`. Only `name`, `base_unit` and `sale_price` are required.
pub async fn import_items(
    State(st): State<AppState>,
    ctx: AuthCtx,
    Query(q): Query<ImportQuery>,
    body: String,
) -> ApiResult<axum::response::Response> {
    ctx.require(Cap::ItemWrite)?;

    let mut lines = body.lines().filter(|l| !l.trim().is_empty());
    let header_line = lines
        .next()
        .ok_or_else(|| ApiError::validation("Berkas kosong: baris judul tidak ada"))?;
    let header: Vec<String> = split_csv_line(header_line)
        .iter()
        .map(|h| h.trim().to_ascii_lowercase())
        .collect();

    let col = |name: &str| header.iter().position(|h| h == name);
    let (i_name, i_unit, i_price) = match (col("name"), col("base_unit"), col("sale_price")) {
        (Some(a), Some(b), Some(c)) => (a, b, c),
        _ => {
            return Err(ApiError::validation(
                "Baris judul harus memuat kolom name, base_unit, sale_price",
            ))
        }
    };
    let (i_sku, i_cost, i_min, i_barcode) =
        (col("sku"), col("cost"), col("min_stock"), col("barcode"));

    // A generous cap: one file, one transaction, no unbounded memory.
    const MAX_ROWS: usize = 5_000;

    let mut tx = begin_tx(&st.pool, &ctx).await?;
    let mut created = 0usize;
    let mut errors: Vec<Value> = Vec::new();
    let mut seen_skus: Vec<String> = Vec::new();

    for (offset, line) in lines.enumerate() {
        let row_no = offset + 2; // 1-based, after the header
        if offset >= MAX_ROWS {
            errors.push(json!({
                "row": row_no,
                "error": format!("Melebihi batas {MAX_ROWS} baris per berkas"),
            }));
            break;
        }
        let f = split_csv_line(line);
        let get = |i: Option<usize>| i.and_then(|i| f.get(i)).map(|s| s.trim().to_string());

        let name = get(Some(i_name)).unwrap_or_default();
        let unit = get(Some(i_unit)).unwrap_or_default();
        let price_raw = get(Some(i_price)).unwrap_or_default();
        let price_digits: String = price_raw
            .chars()
            .filter(|c| c.is_ascii_digit() || *c == '-')
            .collect();
        let sale_price = match price_digits.parse::<i64>() {
            Ok(v) => v,
            Err(_) => {
                errors.push(json!({
                    "row": row_no,
                    "error": format!("Harga jual tidak valid: {price_raw}"),
                }));
                continue;
            }
        };
        let cost = match get(i_cost).filter(|s| !s.is_empty()) {
            Some(raw) => {
                let digits: String = raw
                    .chars()
                    .filter(|c| c.is_ascii_digit() || *c == '-')
                    .collect();
                match digits.parse::<i64>() {
                    Ok(v) => Some(v),
                    Err(_) => {
                        errors.push(json!({
                            "row": row_no,
                            "error": format!("Harga beli tidak valid: {raw}"),
                        }));
                        continue;
                    }
                }
            }
            None => None,
        };
        let min_stock = match get(i_min).filter(|s| !s.is_empty()) {
            Some(raw) => match raw.replace(',', ".").parse::<rust_decimal::Decimal>() {
                Ok(v) => Some(v),
                Err(_) => {
                    errors.push(json!({
                        "row": row_no,
                        "error": format!("Stok minimum tidak valid: {raw}"),
                    }));
                    continue;
                }
            },
            None => None,
        };
        let sku = get(i_sku).filter(|s| !s.is_empty());
        if let Some(s) = &sku {
            if seen_skus.iter().any(|x| x.eq_ignore_ascii_case(s)) {
                errors.push(json!({
                    "row": row_no,
                    "error": format!("SKU {s} muncul lebih dari sekali di berkas"),
                }));
                continue;
            }
        }

        let barcodes = get(i_barcode).filter(|s| !s.is_empty()).map(|s| vec![s]);

        let req = CreateItemReq {
            name,
            sku: sku.clone(),
            barcodes,
            category_id: None,
            base_unit: unit,
            units: None,
            sale_price,
            cost,
            min_stock,
            active: None,
            op_id: None,
        };

        if q.dry_run {
            // Validate without writing: run the same rule checks the real
            // path uses, then undo the insert immediately.
            sqlx::query("savepoint imp").execute(&mut *tx).await?;
            match apply_create_item(&mut tx, &ctx, &req).await {
                Ok(_) => {
                    sqlx::query("rollback to savepoint imp")
                        .execute(&mut *tx)
                        .await?;
                    created += 1;
                    if let Some(s) = sku {
                        seen_skus.push(s);
                    }
                }
                Err(e) => {
                    sqlx::query("rollback to savepoint imp")
                        .execute(&mut *tx)
                        .await?;
                    errors.push(json!({ "row": row_no, "error": e.message() }));
                }
            }
            continue;
        }

        sqlx::query("savepoint imp").execute(&mut *tx).await?;
        match apply_create_item(&mut tx, &ctx, &req).await {
            Ok(_) => {
                sqlx::query("release savepoint imp")
                    .execute(&mut *tx)
                    .await?;
                created += 1;
                if let Some(s) = sku {
                    seen_skus.push(s);
                }
            }
            Err(e) => {
                sqlx::query("rollback to savepoint imp")
                    .execute(&mut *tx)
                    .await?;
                errors.push(json!({ "row": row_no, "error": e.message() }));
            }
        }
    }

    let total = created + errors.len();
    tx.commit().await?;

    let payload = json!({
        "dry_run": q.dry_run,
        "valid": created,
        "failed": errors.len(),
        "total_rows": total,
        "errors": errors,
    });

    // Import reports come back as JSON; the header only reminds a curl user.
    let resp = ([(header::CONTENT_TYPE, "application/json")], Json(payload)).into_response();
    Ok(resp)
}

#[derive(Deserialize)]
pub struct ReconcileQuery {
    pub outlet_id: Option<uuid::Uuid>,
}

/// GET /v1/reports/reconcile — `stock_level` vs the sum of movement deltas.
/// Owner only: it exposes a whole-shop integrity figure. Read-only by design;
/// a mismatch is reported for a human to investigate, never auto-repaired.
pub async fn reconcile(
    State(st): State<AppState>,
    ctx: AuthCtx,
    Query(q): Query<ReconcileQuery>,
) -> ApiResult<Json<Value>> {
    ctx.require(Cap::ReportRead)?;
    let mut tx = begin_tx(&st.pool, &ctx).await?;

    let rows = sqlx::query(
        "select i.id, i.name, i.sku,
                coalesce(sl.qty, 0)::numeric as stock_level,
                coalesce(mv.qty, 0)::numeric as ledger_sum
         from item i
         left join stock_level sl
                on sl.item_id = i.id
               and ($1::uuid is null or sl.outlet_id = $1)
         left join (
             select item_id, outlet_id, sum(qty) as qty
             from stock_move
             group by item_id, outlet_id
         ) mv
                on mv.item_id = i.id
               and ($1::uuid is null or mv.outlet_id = $1)
         where sl.item_id is not null or mv.item_id is not null",
    )
    .bind(q.outlet_id)
    .fetch_all(&mut *tx)
    .await?;

    let mut mismatches = Vec::new();
    let mut checked = 0usize;
    for r in &rows {
        checked += 1;
        let level: rust_decimal::Decimal = r.try_get("stock_level")?;
        let ledger: rust_decimal::Decimal = r.try_get("ledger_sum")?;
        if level != ledger {
            mismatches.push(json!({
                "item_id": r.try_get::<uuid::Uuid, _>("id")?,
                "name": r.try_get::<String, _>("name")?,
                "sku": r.try_get::<Option<String>, _>("sku")?,
                "stock_level": crate::util::qty_json(&level),
                "ledger_sum": crate::util::qty_json(&ledger),
                "difference": crate::util::qty_json(&(level - ledger)),
            }));
        }
    }
    tx.commit().await?;

    Ok(Json(json!({
        "checked": checked,
        "mismatches": mismatches,
        "ok": mismatches.is_empty(),
    })))
}
