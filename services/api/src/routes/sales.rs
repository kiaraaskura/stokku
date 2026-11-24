use chrono::{DateTime, NaiveDate, Utc};
use rust_decimal::Decimal;
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::{PgConnection, Row};
use uuid::Uuid;

use axum::extract::{Path, Query, State};
use axum::Json;

use crate::ctx::{AuthCtx, Cap};
use crate::error::{ApiError, ApiResult};
use crate::routes::items::{post_void_return, VoidReturn};
use crate::state::AppState;
use crate::stock::{post_move, PostMove};
use crate::util::{begin_tx, now_v7, parse_date, qty_json, today_jakarta};

#[derive(Deserialize)]
pub struct SaleLineReq {
    pub item_id: Uuid,
    #[serde(deserialize_with = "crate::util::de_qty")]
    pub qty: Decimal,
    pub unit_price: i64,
    #[serde(default, deserialize_with = "de_disc_opt")]
    pub discount: Option<i64>,
}

fn de_disc_opt<'de, D>(d: D) -> Result<Option<i64>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let v = Value::deserialize(d)?;
    match v {
        Value::Null => Ok(None),
        Value::Number(n) => n
            .as_i64()
            .map(Some)
            .ok_or_else(|| serde::de::Error::custom("diskon harus integer rupiah")),
        _ => Err(serde::de::Error::custom("diskon harus integer rupiah")),
    }
}

#[derive(Deserialize)]
pub struct SaleReq {
    pub outlet_id: Option<Uuid>,
    pub business_date: Option<String>,
    pub customer_id: Option<Uuid>,
    pub discount: Option<i64>,
    pub payment_method: String,
    pub paid: Option<bool>,
    pub note: Option<String>,
    pub lines: Vec<SaleLineReq>,
    pub op_id: Option<Uuid>,
}

struct LinePlan {
    item_id: Uuid,
    qty: Decimal,
    unit_price: i64,
    discount: i64,
    cost_at_sale: i64,
}

/// POST /v1/sales — atomic: sale + lines + one stock move per line
/// + cash entry if paid + receivable stub when credit.
pub async fn create(
    State(st): State<AppState>,
    ctx: AuthCtx,
    Json(body): Json<SaleReq>,
) -> ApiResult<Json<Value>> {
    ctx.require(Cap::SalesWrite)?;

    if body.lines.is_empty() {
        return Err(ApiError::validation_field(
            "Penjualan harus punya minimal satu baris",
            "lines",
            "min 1 baris",
        ));
    }
    if !matches!(
        body.payment_method.as_str(),
        "cash" | "transfer" | "qris" | "credit"
    ) {
        return Err(ApiError::validation_field(
            "Metode pembayaran tidak valid",
            "payment_method",
            "cash | transfer | qris | credit",
        ));
    }
    let sale_discount = body.discount.unwrap_or(0);
    if sale_discount < 0 {
        return Err(ApiError::validation_field(
            "Diskon tidak boleh negatif",
            "discount",
            "min 0",
        ));
    }
    let business_date = match &body.business_date {
        Some(s) => parse_date(s)?,
        None => today_jakarta(),
    };
    let paid = body.paid.unwrap_or(body.payment_method != "credit");
    if body.payment_method == "credit" && paid {
        return Err(ApiError::validation_field(
            "Penjualan kredit tidak bisa langsung lunas; tandai paid setelah dibayar",
            "paid",
            "false untuk credit",
        ));
    }

    // validate lines
    let mut plans: Vec<LinePlan> = Vec::with_capacity(body.lines.len());
    for l in &body.lines {
        if l.qty <= Decimal::ZERO {
            return Err(ApiError::validation_field(
                "Qty harus lebih dari 0",
                "lines.qty",
                "min 0.001",
            ));
        }
        if l.unit_price < 0 {
            return Err(ApiError::validation_field(
                "Harga satuan tidak boleh negatif",
                "lines.unit_price",
                "min 0",
            ));
        }
        let discount = l.discount.unwrap_or(0);
        if discount < 0 {
            return Err(ApiError::validation_field(
                "Diskon baris tidak boleh negatif",
                "lines.discount",
                "min 0",
            ));
        }
        let line_value = crate::util::dec_to_rupiah(&(l.qty * Decimal::from(l.unit_price)));
        if discount > line_value {
            return Err(ApiError::validation_field(
                "Diskon baris melebihi nilai baris",
                "lines.discount",
                "maks nilai baris",
            ));
        }
        plans.push(LinePlan {
            item_id: l.item_id,
            qty: l.qty,
            unit_price: l.unit_price,
            discount,
            cost_at_sale: 0,
        });
    }
    // stable lock order to avoid deadlocks
    plans.sort_by_key(|p| p.item_id);

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

    // lock items and read cost at sale (owner-visible)
    for p in &mut plans {
        let row = sqlx::query("select id, cost_avg, name from item where id = $1 for update")
            .bind(p.item_id)
            .fetch_optional(&mut *tx)
            .await?;
        let row = row.ok_or_else(|| ApiError::NotFound("Item tidak ditemukan".into()))?;
        p.cost_at_sale = row.try_get::<i64, _>("cost_avg")?;
    }

    let mut total: i64 = 0;
    for p in &plans {
        total += crate::util::dec_to_rupiah(&(p.qty * Decimal::from(p.unit_price))) - p.discount;
    }
    total -= sale_discount;
    if total < 0 {
        return Err(ApiError::validation_field(
            "Total setelah diskon tidak boleh negatif",
            "discount",
            "kurangi diskon",
        ));
    }

    let sale_id = now_v7();
    let count: i64 = sqlx::query_scalar("select count(*) from sale")
        .fetch_one(&mut *tx)
        .await?;
    let number = format!("S{:06}", count + 1);

    sqlx::query(
        "insert into sale
           (id, tenant_id, outlet_id, number, customer_id, total, discount, payment_method,
            paid, mode, business_date, voided_at, void_reason, op_id, created_by)
         values ($1, current_setting('app.tenant_id')::uuid, $2, $3, $4, $5, $6, $7, $8,
                 'per_item', $9, null, null, $10, $11)",
    )
    .bind(sale_id)
    .bind(outlet_id)
    .bind(&number)
    .bind(body.customer_id)
    .bind(total)
    .bind(sale_discount)
    .bind(&body.payment_method)
    .bind(paid)
    .bind(business_date)
    .bind(body.op_id)
    .bind(ctx.user_id)
    .execute(&mut *tx)
    .await?;

    let mut created_moves: Vec<Uuid> = Vec::new();
    for p in &plans {
        let line_id = now_v7();
        sqlx::query(
            "insert into sale_line (id, sale_id, item_id, qty, unit_price, discount, cost_at_sale)
             values ($1, $2, $3, $4, $5, $6, $7)",
        )
        .bind(line_id)
        .bind(sale_id)
        .bind(p.item_id)
        .bind(p.qty)
        .bind(p.unit_price)
        .bind(p.discount)
        .bind(p.cost_at_sale)
        .execute(&mut *tx)
        .await?;

        let move_id = post_move(
            &mut tx,
            ctx.user_id,
            &PostMove {
                item_id: p.item_id,
                outlet_id,
                qty: -p.qty,
                unit_cost: p.cost_at_sale,
                kind: "sale",
                ref_type: Some("sale".into()),
                ref_id: Some(sale_id),
                business_date,
                note: body.note.clone(),
                op_id: None,
            },
            None,
        )
        .await?;
        created_moves.push(move_id);
    }

    let payment_id = now_v7();
    let status = if paid { "paid" } else { "pending" };
    sqlx::query(
        "insert into payment
           (id, tenant_id, sale_id, method, amount_gross, mdr_amount, amount_net, status, paid_at)
         values ($1, current_setting('app.tenant_id')::uuid, $2, $3, $4, 0, $5, $6, $7)",
    )
    .bind(payment_id)
    .bind(sale_id)
    .bind(&body.payment_method)
    .bind(total)
    .bind(total)
    .bind(status)
    .bind(if paid { Some(Utc::now()) } else { None })
    .execute(&mut *tx)
    .await?;

    let mut cash_entry_id: Option<Uuid> = None;
    if paid {
        let cid = now_v7();
        sqlx::query(
            "insert into cash_entry
               (id, tenant_id, outlet_id, direction, amount, category, method, ref_type, ref_id,
                business_date, note, created_by)
             values ($1, current_setting('app.tenant_id')::uuid, $2, 'in', $3, 'penjualan', $4,
                     'sale', $5, $6, $7, $8)",
        )
        .bind(cid)
        .bind(outlet_id)
        .bind(total)
        .bind(&body.payment_method)
        .bind(sale_id)
        .bind(business_date)
        .bind(body.note.as_deref())
        .bind(ctx.user_id)
        .execute(&mut *tx)
        .await?;
        cash_entry_id = Some(cid);
    }

    let mut receivable_id: Option<Uuid> = None;
    if !paid {
        // receivable stub; contact defaults to a per-tenant "Pelanggan Umum"
        let contact_id = ensure_generic_customer(&mut tx).await?;
        let rid = now_v7();
        sqlx::query(
            "insert into receivable (id, tenant_id, contact_id, sale_id, amount, due_date, paid_amount)
             values ($1, current_setting('app.tenant_id')::uuid, $2, $3, $4, $5, 0)",
        )
        .bind(rid)
        .bind(contact_id)
        .bind(sale_id)
        .bind(total)
        .bind(business_date + chrono::Duration::days(30))
        .execute(&mut *tx)
        .await?;
        receivable_id = Some(rid);
    }

    if let Some(op_id) = body.op_id {
        sqlx::query(
            "insert into op_log (op_id, tenant_id, result)
             values ($1, current_setting('app.tenant_id')::uuid, $2)",
        )
        .bind(op_id)
        .bind(json!({ "status": "applied", "endpoint": "sale.create", "row_id": sale_id }))
        .execute(&mut *tx)
        .await?;
    }

    tx.commit().await?;

    let include_cost = ctx.can_read_cost();
    Ok(Json(json!({
        "id": sale_id,
        "number": number,
        "outlet_id": outlet_id,
        "total": total,
        "discount": sale_discount,
        "payment_method": body.payment_method,
        "paid": paid,
        "mode": "per_item",
        "business_date": business_date,
        "voided_at": null,
        "lines": plans.iter().map(|p| {
            let mut v = json!({
                "item_id": p.item_id,
                "qty": qty_json(&p.qty),
                "unit_price": p.unit_price,
                "discount": p.discount,
            });
            if include_cost {
                v["cost_at_sale"] = json!(p.cost_at_sale);
            }
            v
        }).collect::<Vec<_>>(),
        "payment": {
            "id": payment_id,
            "method": body.payment_method,
            "amount_gross": total,
            "mdr_amount": 0,
            "amount_net": total,
            "status": status,
        },
        "cash_entry_id": cash_entry_id,
        "receivable_id": receivable_id,
        "created_moves": created_moves,
    })))
}

async fn ensure_generic_customer(tx: &mut PgConnection) -> ApiResult<Uuid> {
    let existing: Option<Uuid> = sqlx::query_scalar(
        "select id from contact where type = 'customer' and name = 'Pelanggan Umum' limit 1",
    )
    .fetch_optional(&mut *tx)
    .await?;
    if let Some(id) = existing {
        return Ok(id);
    }
    let id = now_v7();
    sqlx::query(
        "insert into contact (id, tenant_id, type, name)
         values ($1, current_setting('app.tenant_id')::uuid, 'customer', 'Pelanggan Umum')",
    )
    .bind(id)
    .execute(&mut *tx)
    .await?;
    Ok(id)
}

#[derive(Deserialize)]
pub struct SaleListQuery {
    pub from: Option<String>,
    pub to: Option<String>,
    pub cursor: Option<Uuid>,
}

/// GET /v1/sales?from=&to=&cursor=
pub async fn list(
    State(st): State<AppState>,
    ctx: AuthCtx,
    Query(q): Query<SaleListQuery>,
) -> ApiResult<Json<Value>> {
    let from = match &q.from {
        Some(s) => Some(parse_date(s)?),
        None => None,
    };
    let to = match &q.to {
        Some(s) => Some(parse_date(s)?),
        None => None,
    };
    let mut tx = begin_tx(&st.pool, &ctx).await?;
    let rows = sqlx::query(
        "select id, number, outlet_id, total, discount, payment_method, paid, mode,
                business_date, voided_at, void_reason, note, created_by, created_at
         from sale
         where ($1::date is null or business_date >= $1)
           and ($2::date is null or business_date <= $2)
           and ($3::uuid is null or id < $3)
         order by id desc
         limit 51",
    )
    .bind(from)
    .bind(to)
    .bind(q.cursor)
    .fetch_all(&mut *tx)
    .await?;
    tx.commit().await?;

    let has_more = rows.len() > 50;
    let next_cursor = if has_more {
        rows.get(49)
            .map(|r| r.try_get::<Uuid, _>("id"))
            .transpose()?
    } else {
        None
    };
    let data: Vec<Value> = rows
        .into_iter()
        .take(50)
        .map(|r| {
            let v = json!({
                "id": r.try_get::<Uuid, _>("id")?,
                "number": r.try_get::<Option<String>, _>("number")?,
                "outlet_id": r.try_get::<Uuid, _>("outlet_id")?,
                "total": r.try_get::<i64, _>("total")?,
                "discount": r.try_get::<i64, _>("discount")?,
                "payment_method": r.try_get::<String, _>("payment_method")?,
                "paid": r.try_get::<bool, _>("paid")?,
                "mode": r.try_get::<String, _>("mode")?,
                "business_date": r.try_get::<NaiveDate, _>("business_date")?,
                "voided_at": r.try_get::<Option<DateTime<Utc>>, _>("voided_at")?,
                "void_reason": r.try_get::<Option<String>, _>("void_reason")?,
                "created_by": r.try_get::<Option<Uuid>, _>("created_by")?,
                "created_at": r.try_get::<DateTime<Utc>, _>("created_at")?,
            });
            Ok(v)
        })
        .collect::<ApiResult<Vec<_>>>()?;
    Ok(Json(json!({ "data": data, "next_cursor": next_cursor })))
}

/// GET /v1/sales/{id} — with lines + payment.
pub async fn get_one(
    State(st): State<AppState>,
    ctx: AuthCtx,
    Path(id): Path<Uuid>,
) -> ApiResult<Json<Value>> {
    let mut tx = begin_tx(&st.pool, &ctx).await?;
    let sale = load_sale(&mut tx, id).await?;
    let include_cost = ctx.can_read_cost();
    let mut v = sale_json(&sale)?;

    let lines: Vec<(Uuid, Uuid, Decimal, i64, i64, i64)> = sqlx::query_as(
        "select id, item_id, qty, unit_price, discount, cost_at_sale
         from sale_line where sale_id = $1 order by id",
    )
    .bind(id)
    .fetch_all(&mut *tx)
    .await?;
    v["lines"] = json!(lines
        .iter()
        .map(|(lid, item, qty, price, disc, cost)| {
            let mut line = json!({
                "id": lid,
                "item_id": item,
                "qty": qty_json(qty),
                "unit_price": price,
                "discount": disc,
            });
            if include_cost {
                line["cost_at_sale"] = json!(cost);
            }
            line
        })
        .collect::<Vec<_>>());

    let payment: Option<(Uuid, String, i64, i64, i64, String)> = sqlx::query_as(
        "select id, method, amount_gross, mdr_amount, amount_net, status
         from payment where sale_id = $1 limit 1",
    )
    .bind(id)
    .fetch_optional(&mut *tx)
    .await?;
    v["payment"] = match payment {
        Some((pid, method, gross, mdr, net, status)) => json!({
            "id": pid, "method": method, "amount_gross": gross,
            "mdr_amount": mdr, "amount_net": net, "status": status,
        }),
        None => Value::Null,
    };
    tx.commit().await?;
    Ok(Json(v))
}

struct SaleRow {
    id: Uuid,
    number: Option<String>,
    outlet_id: Uuid,
    total: i64,
    discount: i64,
    payment_method: String,
    paid: bool,
    mode: String,
    business_date: NaiveDate,
    voided_at: Option<DateTime<Utc>>,
    void_reason: Option<String>,
    created_by: Option<Uuid>,
    created_at: DateTime<Utc>,
}

async fn load_sale(tx: &mut PgConnection, id: Uuid) -> ApiResult<SaleRow> {
    let row = sqlx::query(
        "select id, number, outlet_id, total, discount, payment_method, paid, mode,
                business_date, voided_at, void_reason, created_by, created_at
         from sale where id = $1",
    )
    .bind(id)
    .fetch_optional(&mut *tx)
    .await?;
    let row = row.ok_or_else(|| ApiError::NotFound("Penjualan tidak ditemukan".into()))?;
    Ok(SaleRow {
        id: row.try_get("id")?,
        number: row.try_get("number")?,
        outlet_id: row.try_get("outlet_id")?,
        total: row.try_get("total")?,
        discount: row.try_get("discount")?,
        payment_method: row.try_get("payment_method")?,
        paid: row.try_get("paid")?,
        mode: row.try_get("mode")?,
        business_date: row.try_get("business_date")?,
        voided_at: row.try_get("voided_at")?,
        void_reason: row.try_get("void_reason")?,
        created_by: row.try_get("created_by")?,
        created_at: row.try_get("created_at")?,
    })
}

fn sale_json(s: &SaleRow) -> ApiResult<Value> {
    Ok(json!({
        "id": s.id,
        "number": s.number,
        "outlet_id": s.outlet_id,
        "total": s.total,
        "discount": s.discount,
        "payment_method": s.payment_method,
        "paid": s.paid,
        "mode": s.mode,
        "business_date": s.business_date,
        "voided_at": s.voided_at,
        "void_reason": s.void_reason,
        "created_by": s.created_by,
        "created_at": s.created_at,
    }))
}

#[derive(Deserialize)]
pub struct VoidReq {
    pub reason: String,
}

/// POST /v1/sales/{id}/void — reverses stock and money; never deletes.
pub async fn void(
    State(st): State<AppState>,
    ctx: AuthCtx,
    Path(id): Path<Uuid>,
    Json(body): Json<VoidReq>,
) -> ApiResult<Json<Value>> {
    ctx.require(Cap::SalesWrite)?;
    if body.reason.trim().is_empty() {
        return Err(ApiError::validation_field(
            "Alasan void wajib diisi",
            "reason",
            "tidak boleh kosong",
        ));
    }

    let mut tx = begin_tx(&st.pool, &ctx).await?;
    let sale = load_sale(&mut tx, id).await?;
    if sale.voided_at.is_some() {
        return Err(ApiError::Conflict("Penjualan ini sudah di-void".into()));
    }

    let lines: Vec<(Uuid, Decimal, i64)> = sqlx::query_as(
        "select item_id, qty, cost_at_sale from sale_line where sale_id = $1 order by id",
    )
    .bind(id)
    .fetch_all(&mut *tx)
    .await?;

    let mut reversal_moves: Vec<Uuid> = Vec::new();
    for (item_id, qty, cost) in &lines {
        let move_id = post_void_return(
            &mut tx,
            ctx.user_id,
            &VoidReturn {
                item_id: *item_id,
                outlet_id: sale.outlet_id,
                qty: *qty,
                unit_cost: *cost,
                business_date: today_jakarta(),
                sale_id: id,
            },
        )
        .await?;
        reversal_moves.push(move_id);
    }

    // reverse the cash entry if the sale created one
    let cash_row: Option<(Uuid, i64, NaiveDate)> = sqlx::query_as(
        "select id, amount, business_date from cash_entry
         where ref_type = 'sale' and ref_id = $1 limit 1",
    )
    .bind(id)
    .fetch_optional(&mut *tx)
    .await?;
    let mut cash_reversal_id: Option<Uuid> = None;
    if let Some((_cid, amount, bdate)) = cash_row {
        let rid = now_v7();
        sqlx::query(
            "insert into cash_entry
               (id, tenant_id, outlet_id, direction, amount, category, ref_type, ref_id,
                business_date, note, created_by)
             values ($1, current_setting('app.tenant_id')::uuid, $2, 'out', $3, 'penjualan',
                     'sale_void', $4, $5, $6, $7)",
        )
        .bind(rid)
        .bind(sale.outlet_id)
        .bind(amount)
        .bind(id)
        .bind(bdate)
        .bind(format!("Pembalikan penjualan: {}", body.reason.trim()))
        .bind(ctx.user_id)
        .execute(&mut *tx)
        .await?;
        cash_reversal_id = Some(rid);
    }

    // settle the receivable stub so it stops counting as outstanding
    sqlx::query(
        "update receivable set paid_amount = amount where sale_id = $1 and paid_amount = 0",
    )
    .bind(id)
    .execute(&mut *tx)
    .await?;

    // mark payment refunded + sale voided
    sqlx::query("update payment set status = 'refunded' where sale_id = $1")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    sqlx::query("update sale set voided_at = now(), void_reason = $2 where id = $1")
        .bind(id)
        .bind(body.reason.trim())
        .execute(&mut *tx)
        .await?;

    tx.commit().await?;

    let sale = SaleRow {
        voided_at: Some(Utc::now()),
        void_reason: Some(body.reason.trim().to_string()),
        ..sale
    };
    let mut v = sale_json(&sale)?;
    v["voided"] = json!(true);
    v["reversal_moves"] = json!(reversal_moves);
    v["cash_reversal_id"] = json!(cash_reversal_id);
    Ok(Json(v))
}
