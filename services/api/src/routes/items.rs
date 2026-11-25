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
use crate::state::AppState;
use crate::stock::{post_move, PostMove};
use crate::util::{begin_tx, now_v7, qty_json};

fn item_core_select() -> &'static str {
    "select i.id, i.sku, i.name, i.category_id, i.base_unit, i.sale_price, i.cost_avg,
            i.min_stock, i.active, i.updated_at, i.deleted_at,
            coalesce((select sum(sl.qty) from stock_level sl where sl.item_id = i.id), 0) as stock
     from item i"
}

fn item_row_json(row: &sqlx::postgres::PgRow, include_cost: bool) -> ApiResult<Value> {
    let stock: Decimal = row.try_get("stock")?;
    let min_stock: Decimal = row.try_get("min_stock")?;
    let mut v = json!({
        "id": row.try_get::<Uuid, _>("id")?,
        "sku": row.try_get::<Option<String>, _>("sku")?,
        "name": row.try_get::<String, _>("name")?,
        "category_id": row.try_get::<Option<Uuid>, _>("category_id")?,
        "base_unit": row.try_get::<String, _>("base_unit")?,
        "sale_price": row.try_get::<i64, _>("sale_price")?,
        "min_stock": qty_json(&min_stock),
        "active": row.try_get::<bool, _>("active")?,
        "stock": qty_json(&stock),
        "low_stock": stock <= min_stock,
        "negative_stock": stock < Decimal::ZERO,
        "updated_at": row.try_get::<DateTime<Utc>, _>("updated_at")?,
    });
    if include_cost {
        v["cost_avg"] = json!(row.try_get::<i64, _>("cost_avg")?);
    }
    Ok(v)
}

#[derive(Deserialize)]
pub struct UnitReq {
    pub name: String,
    #[serde(deserialize_with = "crate::util::de_qty")]
    pub factor: Decimal,
}

#[derive(Deserialize)]
pub struct CreateItemReq {
    pub name: String,
    pub sku: Option<String>,
    pub barcodes: Option<Vec<String>>,
    pub category_id: Option<Uuid>,
    pub base_unit: String,
    pub units: Option<Vec<UnitReq>>,
    pub sale_price: i64,
    pub cost: Option<i64>,
    #[serde(default, deserialize_with = "crate::util::de_qty_opt")]
    pub min_stock: Option<Decimal>,
    pub active: Option<bool>,
    pub op_id: Option<Uuid>,
}

/// POST /v1/items — owner only (item.write). op_id dedupes retries
/// through op_log (the exactly-once gap Frontend flagged).
pub async fn create(
    State(st): State<AppState>,
    ctx: AuthCtx,
    Json(body): Json<CreateItemReq>,
) -> ApiResult<Json<Value>> {
    ctx.require(Cap::ItemWrite)?;
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
    let v = apply_create_item(&mut tx, &ctx, &body).await?;
    if let Some(op_id) = body.op_id {
        let row_id: Uuid = serde_json::from_value(v["id"].clone()).unwrap_or(op_id);
        sqlx::query(
            "insert into op_log (op_id, tenant_id, result)
             values ($1, current_setting('app.tenant_id')::uuid, $2)",
        )
        .bind(op_id)
        .bind(json!({ "status": "applied", "endpoint": "item.create", "row_id": row_id }))
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;
    Ok(Json(v))
}

/// The single item-create path, shared by REST and sync push.
pub async fn apply_create_item(
    tx: &mut PgConnection,
    ctx: &AuthCtx,
    body: &CreateItemReq,
) -> ApiResult<Value> {
    ctx.require(Cap::ItemWrite)?;
    if body.name.trim().is_empty() {
        return Err(ApiError::validation_field(
            "Nama wajib diisi",
            "name",
            "tidak boleh kosong",
        ));
    }
    if body.base_unit.trim().is_empty() {
        return Err(ApiError::validation_field(
            "Satuan dasar wajib diisi",
            "base_unit",
            "misal pcs atau kg",
        ));
    }
    if body.sale_price < 0 {
        return Err(ApiError::validation_field(
            "Harga jual tidak boleh negatif",
            "sale_price",
            "min 0",
        ));
    }
    if let Some(cost) = body.cost {
        if cost < 0 {
            return Err(ApiError::validation_field(
                "Harga beli tidak boleh negatif",
                "cost",
                "min 0",
            ));
        }
    }
    for u in body.units.iter().flatten() {
        if u.name.trim().is_empty() {
            return Err(ApiError::validation_field(
                "Nama satuan wajib diisi",
                "units",
                "tidak boleh kosong",
            ));
        }
        if u.factor <= Decimal::ZERO {
            return Err(ApiError::validation_field(
                "Faktor satuan harus lebih dari 0",
                "units",
                "misal dus = 24",
            ));
        }
    }
    let barcodes: Vec<String> = body
        .barcodes
        .iter()
        .flatten()
        .map(|b| b.trim().to_string())
        .collect();
    if barcodes.iter().any(|b| b.is_empty()) {
        return Err(ApiError::validation_field(
            "Barcode tidak boleh kosong",
            "barcodes",
            "string tidak kosong",
        ));
    }

    let id = now_v7();

    sqlx::query(
        "insert into item (id, tenant_id, sku, name, category_id, base_unit, sale_price,
                           cost_avg, min_stock, active)
         values ($1, current_setting('app.tenant_id')::uuid, $2, $3, $4, $5, $6, $7, $8, $9)",
    )
    .bind(id)
    .bind(body.sku.as_deref().map(str::trim).filter(|s| !s.is_empty()))
    .bind(body.name.trim())
    .bind(body.category_id)
    .bind(body.base_unit.trim())
    .bind(body.sale_price)
    .bind(body.cost.unwrap_or(0))
    .bind(body.min_stock.unwrap_or(Decimal::ZERO))
    .bind(body.active.unwrap_or(true))
    .execute(&mut *tx)
    .await?;

    for barcode in &barcodes {
        sqlx::query(
            "insert into item_barcode (id, tenant_id, item_id, barcode)
             values ($1, current_setting('app.tenant_id')::uuid, $2, $3)",
        )
        .bind(now_v7())
        .bind(id)
        .bind(barcode)
        .execute(&mut *tx)
        .await?;
    }
    for u in body.units.iter().flatten() {
        sqlx::query(
            "insert into item_unit (id, tenant_id, item_id, name, factor)
             values ($1, current_setting('app.tenant_id')::uuid, $2, $3, $4)",
        )
        .bind(now_v7())
        .bind(id)
        .bind(u.name.trim())
        .bind(u.factor)
        .execute(&mut *tx)
        .await?;
    }

    let row = sqlx::query(&format!("{} where i.id = $1", item_core_select()))
        .bind(id)
        .fetch_one(&mut *tx)
        .await?;
    let mut v = item_row_json(&row, ctx.can_read_cost())?;
    v["barcodes"] = json!(barcodes);
    v["units"] = json!(body
        .units
        .iter()
        .flatten()
        .map(|u| json!({"name": u.name.trim(), "factor": qty_json(&u.factor)}))
        .collect::<Vec<_>>());
    Ok(v)
}

#[derive(Deserialize)]
pub struct ItemListQuery {
    pub q: Option<String>,
    pub category_id: Option<Uuid>,
    pub active: Option<bool>,
    pub low_stock: Option<bool>,
    pub cursor: Option<Uuid>,
}

/// GET /v1/items — search name/SKU/barcode; 50/page.
pub async fn list(
    State(st): State<AppState>,
    ctx: AuthCtx,
    Query(q): Query<ItemListQuery>,
) -> ApiResult<Json<Value>> {
    let like = q.q.as_deref().map(str::trim).filter(|s| !s.is_empty());
    let mut sql = format!("{} where i.deleted_at is null", item_core_select());
    let mut n = 0usize;
    if like.is_some() {
        n += 1;
        sql.push_str(&format!(
            " and (i.name ilike '%'||${n}||'%' or i.sku ilike '%'||${n}||'%'
                 or exists (select 1 from item_barcode b where b.item_id = i.id and b.barcode = ${n}))"
        ));
    }
    if q.category_id.is_some() {
        n += 1;
        sql.push_str(&format!(" and i.category_id = ${n}"));
    }
    if q.active.is_some() {
        n += 1;
        sql.push_str(&format!(" and i.active = ${n}"));
    }
    if q.low_stock == Some(true) {
        sql.push_str(
            " and coalesce((select sum(sl.qty) from stock_level sl where sl.item_id = i.id), 0) <= i.min_stock",
        );
    }
    if q.cursor.is_some() {
        n += 1;
        sql.push_str(&format!(" and i.id < ${n}"));
    }
    sql.push_str(" order by i.id desc limit 51");

    let mut query = sqlx::query(&sql);
    if let Some(needle) = like {
        query = query.bind(needle);
    }
    if let Some(c) = q.category_id {
        query = query.bind(c);
    }
    if let Some(a) = q.active {
        query = query.bind(a);
    }
    if let Some(c) = q.cursor {
        query = query.bind(c);
    }

    let mut tx = begin_tx(&st.pool, &ctx).await?;
    let rows = query.fetch_all(&mut *tx).await?;
    tx.commit().await?;

    let has_more = rows.len() > 50;
    let next_cursor = if has_more {
        rows.get(49)
            .map(|r| r.try_get::<Uuid, _>("id"))
            .transpose()?
    } else {
        None
    };
    let data = rows
        .into_iter()
        .take(50)
        .map(|r| item_row_json(&r, ctx.can_read_cost()))
        .collect::<ApiResult<Vec<_>>>()?;
    Ok(Json(json!({ "data": data, "next_cursor": next_cursor })))
}

/// GET /v1/items/{id} — item + units + barcodes + stock per outlet.
pub async fn get_one(
    State(st): State<AppState>,
    ctx: AuthCtx,
    Path(id): Path<Uuid>,
) -> ApiResult<Json<Value>> {
    let mut tx = begin_tx(&st.pool, &ctx).await?;
    let row = sqlx::query(&format!(
        "{} where i.id = $1 and i.deleted_at is null",
        item_core_select()
    ))
    .bind(id)
    .fetch_optional(&mut *tx)
    .await?;
    let row = row.ok_or_else(|| ApiError::NotFound("Item tidak ditemukan".into()))?;
    let mut v = item_row_json(&row, ctx.can_read_cost())?;

    let barcodes: Vec<String> =
        sqlx::query_scalar("select barcode from item_barcode where item_id = $1 order by barcode")
            .bind(id)
            .fetch_all(&mut *tx)
            .await?;
    let units: Vec<(String, Decimal)> =
        sqlx::query_as("select name, factor from item_unit where item_id = $1 order by name")
            .bind(id)
            .fetch_all(&mut *tx)
            .await?;
    let stock_per_outlet: Vec<(Uuid, Decimal)> = sqlx::query_as(
        "select outlet_id, qty from stock_level where item_id = $1 order by outlet_id",
    )
    .bind(id)
    .fetch_all(&mut *tx)
    .await?;

    v["barcodes"] = json!(barcodes);
    v["units"] = json!(units
        .iter()
        .map(|(name, factor)| json!({"name": name, "factor": qty_json(factor)}))
        .collect::<Vec<_>>());
    v["stock_per_outlet"] = json!(stock_per_outlet
        .iter()
        .map(|(oid, qty)| json!({"outlet_id": oid, "qty": qty_json(qty)}))
        .collect::<Vec<_>>());
    tx.commit().await?;
    Ok(Json(v))
}

/// PATCH /v1/items/{id} — partial; price/cost changes are owner-only
/// (whole endpoint is owner-only because staff lacks item.write).
pub async fn update(
    State(st): State<AppState>,
    ctx: AuthCtx,
    Path(id): Path<Uuid>,
    Json(body): Json<Value>,
) -> ApiResult<Json<Value>> {
    ctx.require(Cap::ItemWrite)?;
    // op_id is transport-level idempotency, not an item field
    let op_id = body
        .get("op_id")
        .and_then(|v| v.as_str())
        .and_then(|v| Uuid::parse_str(v).ok());
    let body = if op_id.is_some() {
        let mut b = body.clone();
        b.as_object_mut().unwrap().remove("op_id");
        b
    } else {
        body
    };
    validate_item_patch_fields(&body)?;

    let mut tx = begin_tx(&st.pool, &ctx).await?;
    if let Some(op_id) = op_id {
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
    let v = apply_update_item(&mut tx, &ctx, id, &body).await?;
    if let Some(op_id) = op_id {
        sqlx::query(
            "insert into op_log (op_id, tenant_id, result)
             values ($1, current_setting('app.tenant_id')::uuid, $2)",
        )
        .bind(op_id)
        .bind(json!({ "status": "applied", "endpoint": "item.update", "row_id": id }))
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;
    Ok(Json(v))
}

fn validate_item_patch_fields(body: &Value) -> ApiResult<()> {
    const KNOWN: [&str; 10] = [
        "name",
        "sku",
        "category_id",
        "base_unit",
        "sale_price",
        "cost",
        "min_stock",
        "active",
        "barcodes",
        "units",
    ];
    if let Some(fields) = body.as_object() {
        if fields.keys().any(|k| !KNOWN.contains(&k.as_str())) {
            let unknown: Vec<&String> = fields
                .keys()
                .filter(|k| !KNOWN.contains(&k.as_str()))
                .collect();
            return Err(ApiError::validation(format!(
                "Field tidak dikenal: {}",
                unknown
                    .iter()
                    .map(|s| s.as_str())
                    .collect::<Vec<_>>()
                    .join(", ")
            )));
        }
    }
    Ok(())
}

/// The single item-update path, shared by REST and sync push.
/// `fields` carries only item columns (no op_id).
pub async fn apply_update_item(
    tx: &mut PgConnection,
    ctx: &AuthCtx,
    id: Uuid,
    body: &Value,
) -> ApiResult<Value> {
    ctx.require(Cap::ItemWrite)?;
    validate_item_patch_fields(body)?;
    let exists: Option<Uuid> =
        sqlx::query_scalar("select id from item where id = $1 and deleted_at is null")
            .bind(id)
            .fetch_optional(&mut *tx)
            .await?;
    if exists.is_none() {
        return Err(ApiError::NotFound("Item tidak ditemukan".into()));
    }

    let mut sets: Vec<String> = Vec::new();
    let mut binds: Vec<Value> = Vec::new();

    let obj = body.as_object().cloned().unwrap_or_default();
    let push = |col: &str, v: Value, sets: &mut Vec<String>, binds: &mut Vec<Value>| {
        sets.push(format!("{col} = ${}", binds.len() + 1));
        binds.push(v);
    };
    if let Some(v) = obj.get("name") {
        let s = v.as_str().map(str::trim).unwrap_or_default();
        if s.is_empty() {
            return Err(ApiError::validation_field(
                "Nama wajib diisi",
                "name",
                "tidak boleh kosong",
            ));
        }
        push("name", json!(s), &mut sets, &mut binds);
    }
    if let Some(v) = obj.get("sku") {
        match v {
            Value::Null => push("sku", Value::Null, &mut sets, &mut binds),
            Value::String(s) => {
                let s = s.trim();
                if s.is_empty() {
                    push("sku", Value::Null, &mut sets, &mut binds);
                } else {
                    push("sku", json!(s), &mut sets, &mut binds);
                }
            }
            _ => return Err(ApiError::validation("sku harus string")),
        }
    }
    if let Some(v) = obj.get("category_id") {
        match Uuid::deserialize(v.clone()) {
            Ok(u) => push("category_id", json!(u), &mut sets, &mut binds),
            Err(_) => return Err(ApiError::validation("category_id tidak valid")),
        }
    }
    if let Some(v) = obj.get("base_unit") {
        let s = v.as_str().map(str::trim).unwrap_or_default();
        if s.is_empty() {
            return Err(ApiError::validation_field(
                "Satuan dasar wajib diisi",
                "base_unit",
                "tidak boleh kosong",
            ));
        }
        push("base_unit", json!(s), &mut sets, &mut binds);
    }
    if let Some(v) = obj.get("sale_price") {
        let p = v.as_i64().ok_or_else(|| {
            ApiError::validation_field("Harga jual harus angka bulat", "sale_price", "integer")
        })?;
        if p < 0 {
            return Err(ApiError::validation_field(
                "Harga jual tidak boleh negatif",
                "sale_price",
                "min 0",
            ));
        }
        push("sale_price", json!(p), &mut sets, &mut binds);
    }
    if let Some(v) = obj.get("cost") {
        let c = v.as_i64().ok_or_else(|| {
            ApiError::validation_field("Harga beli harus angka bulat", "cost", "integer")
        })?;
        if c < 0 {
            return Err(ApiError::validation_field(
                "Harga beli tidak boleh negatif",
                "cost",
                "min 0",
            ));
        }
        push("cost_avg", json!(c), &mut sets, &mut binds);
    }
    if let Some(v) = obj.get("min_stock") {
        let d: Decimal = serde_json::from_value(v.clone())
            .map_err(|_| ApiError::validation("min_stock harus desimal"))?;
        if d < Decimal::ZERO {
            return Err(ApiError::validation_field(
                "Stok minimum tidak boleh negatif",
                "min_stock",
                "min 0",
            ));
        }
        sets.push(format!("min_stock = ${}::numeric", binds.len() + 1));
        binds.push(json!(d.to_string()));
    }
    if let Some(v) = obj.get("active") {
        push(
            "active",
            json!(v.as_bool().unwrap_or(true)),
            &mut sets,
            &mut binds,
        );
    }

    if sets.is_empty() && obj.get("barcodes").is_none() && obj.get("units").is_none() {
        return Err(ApiError::validation("Tidak ada field yang diubah"));
    }

    if !sets.is_empty() {
        let sql = format!(
            "update item set {} where id = ${}",
            sets.join(", "),
            binds.len() + 1
        );
        let mut query = sqlx::query(&sql);
        for b in &binds {
            query = bind_value(query, b);
        }
        query.bind(id).execute(&mut *tx).await?;
    }

    if let Some(v) = obj.get("barcodes") {
        let barcodes: Vec<String> = Vec::<String>::deserialize(v.clone())
            .map_err(|_| ApiError::validation("barcodes harus array string"))?;
        if barcodes.iter().any(|b| b.trim().is_empty()) {
            return Err(ApiError::validation_field(
                "Barcode tidak boleh kosong",
                "barcodes",
                "string tidak kosong",
            ));
        }
        sqlx::query("delete from item_barcode where item_id = $1")
            .bind(id)
            .execute(&mut *tx)
            .await?;
        for b in &barcodes {
            sqlx::query(
                "insert into item_barcode (id, tenant_id, item_id, barcode)
                 values ($1, current_setting('app.tenant_id')::uuid, $2, $3)",
            )
            .bind(now_v7())
            .bind(id)
            .bind(b.trim())
            .execute(&mut *tx)
            .await?;
        }
    }

    if let Some(v) = obj.get("units") {
        let units: Vec<UnitReq> = Vec::<UnitReq>::deserialize(v.clone())
            .map_err(|_| ApiError::validation("units tidak valid"))?;
        for u in &units {
            if u.factor <= Decimal::ZERO {
                return Err(ApiError::validation_field(
                    "Faktor satuan harus lebih dari 0",
                    "units",
                    "misal dus = 24",
                ));
            }
        }
        sqlx::query("delete from item_unit where item_id = $1")
            .bind(id)
            .execute(&mut *tx)
            .await?;
        for u in &units {
            sqlx::query(
                "insert into item_unit (id, tenant_id, item_id, name, factor)
                 values ($1, current_setting('app.tenant_id')::uuid, $2, $3, $4)",
            )
            .bind(now_v7())
            .bind(id)
            .bind(u.name.trim())
            .bind(u.factor)
            .execute(&mut *tx)
            .await?;
        }
    }

    let row = sqlx::query(&format!("{} where i.id = $1", item_core_select()))
        .bind(id)
        .fetch_one(&mut *tx)
        .await?;
    let mut v = item_row_json(&row, ctx.can_read_cost())?;
    let barcodes: Vec<String> =
        sqlx::query_scalar("select barcode from item_barcode where item_id = $1 order by barcode")
            .bind(id)
            .fetch_all(&mut *tx)
            .await?;
    let units: Vec<(String, Decimal)> =
        sqlx::query_as("select name, factor from item_unit where item_id = $1 order by name")
            .bind(id)
            .fetch_all(&mut *tx)
            .await?;
    v["barcodes"] = json!(barcodes);
    v["units"] = json!(units
        .iter()
        .map(|(name, factor)| json!({"name": name, "factor": qty_json(factor)}))
        .collect::<Vec<_>>());
    Ok(v)
}

fn bind_value<'q>(
    query: sqlx::query::Query<'q, sqlx::Postgres, sqlx::postgres::PgArguments>,
    v: &Value,
) -> sqlx::query::Query<'q, sqlx::Postgres, sqlx::postgres::PgArguments> {
    match v {
        Value::Null => query.bind(Option::<String>::None),
        // min_stock is a decimal serialized as string; all other string
        // columns are text. Cast at the SQL placeholder instead:
        // min_stock is the only column bound as "{n}::numeric".
        Value::String(s) => query.bind(s.clone()),
        Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                query.bind(i)
            } else if let Some(u) = n.as_u64() {
                query.bind(i64::try_from(u).unwrap_or(i64::MAX))
            } else {
                query.bind(n.as_f64().unwrap_or(0.0))
            }
        }
        Value::Bool(b) => query.bind(*b),
        other => query.bind(other.to_string()),
    }
}

/// DELETE /v1/items/{id} — soft delete; 409 when movements exist.
pub async fn soft_delete(
    State(st): State<AppState>,
    ctx: AuthCtx,
    Path(id): Path<Uuid>,
) -> ApiResult<Json<Value>> {
    ctx.require(Cap::ItemWrite)?;
    let mut tx = begin_tx(&st.pool, &ctx).await?;
    let moves: i64 = sqlx::query_scalar("select count(*) from stock_move where item_id = $1")
        .bind(id)
        .fetch_one(&mut *tx)
        .await?;
    if moves > 0 {
        return Err(ApiError::Conflict(
            "Item tidak bisa dihapus karena sudah ada pergerakan stok. Nonaktifkan saja itemnya."
                .into(),
        ));
    }
    let res =
        sqlx::query("update item set deleted_at = now() where id = $1 and deleted_at is null")
            .bind(id)
            .execute(&mut *tx)
            .await?;
    tx.commit().await?;
    if res.rows_affected() == 0 {
        return Err(ApiError::NotFound("Item tidak ditemukan".into()));
    }
    Ok(Json(json!({ "id": id, "deleted": true })))
}

/// GET /v1/items/search?q= — typeahead, max 10, barcode exact first.
pub async fn search(
    State(st): State<AppState>,
    ctx: AuthCtx,
    Query(q): Query<std::collections::HashMap<String, String>>,
) -> ApiResult<Json<Value>> {
    let needle = q
        .get("q")
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| ApiError::validation_field("Parameter q wajib diisi", "q", "kata kunci"))?;

    let mut tx = begin_tx(&st.pool, &ctx).await?;

    // barcode exact match first
    let barcode_rows = sqlx::query(&format!(
        "{} join item_barcode b on b.item_id = i.id
          where b.barcode = $1 and i.deleted_at is null
          order by i.name limit 10",
        item_core_select()
    ))
    .bind(needle)
    .fetch_all(&mut *tx)
    .await?;

    let exclude: Vec<Uuid> = barcode_rows
        .iter()
        .filter_map(|r| r.try_get("id").ok())
        .collect();

    let base = format!(
        "{} where i.deleted_at is null and i.name ilike '%'||$1||'%'",
        item_core_select()
    );
    let name_rows = if exclude.is_empty() {
        sqlx::query(&format!("{base} order by i.name limit 10"))
            .bind(needle)
            .fetch_all(&mut *tx)
            .await?
    } else {
        sqlx::query(&format!(
            "{base} and i.id <> all($2) order by i.name limit 9"
        ))
        .bind(needle)
        .bind(exclude)
        .fetch_all(&mut *tx)
        .await?
    };

    tx.commit().await?;

    let mut data: Vec<Value> = Vec::new();
    let cap = ctx.can_read_cost();
    for r in barcode_rows.iter().chain(name_rows.iter()) {
        data.push(item_row_json(r, cap)?);
        if data.len() >= 10 {
            break;
        }
    }
    Ok(Json(json!({ "data": data, "next_cursor": null })))
}

/// GET /v1/items/{id}/ledger — running balance per row + closing qty.
pub async fn ledger(
    State(st): State<AppState>,
    ctx: AuthCtx,
    Path(id): Path<Uuid>,
    Query(q): Query<std::collections::HashMap<String, String>>,
) -> ApiResult<Json<Value>> {
    let outlet_id = match q.get("outlet_id") {
        Some(s) => {
            Some(Uuid::parse_str(s).map_err(|_| ApiError::validation("outlet_id tidak valid"))?)
        }
        None => None,
    };

    let mut tx = begin_tx(&st.pool, &ctx).await?;
    let outlet_id = match outlet_id {
        Some(o) => o,
        None => crate::util::default_outlet_id(&mut tx).await?,
    };

    let exists: Option<Uuid> = sqlx::query_scalar("select id from item where id = $1")
        .bind(id)
        .fetch_optional(&mut *tx)
        .await?;
    if exists.is_none() {
        return Err(ApiError::NotFound("Item tidak ditemukan".into()));
    }

    let rows = sqlx::query(
        "select sm.id, sm.business_date, sm.type, sm.qty, sm.unit_cost, sm.ref_type, sm.ref_id,
                sm.note, sm.created_by, sm.created_at,
                sum(sm.qty) over (order by sm.business_date, sm.created_at, sm.id) as balance,
                m.role as actor_role
         from stock_move sm
         left join membership m on m.user_id = sm.created_by
              and m.tenant_id = current_setting('app.tenant_id')::uuid
         where sm.item_id = $1 and sm.outlet_id = $2
         order by sm.business_date, sm.created_at, sm.id",
    )
    .bind(id)
    .bind(outlet_id)
    .fetch_all(&mut *tx)
    .await?;

    let closing: Decimal = sqlx::query_scalar(
        "select coalesce((select qty from stock_level where item_id = $1 and outlet_id = $2), 0)",
    )
    .bind(id)
    .bind(outlet_id)
    .fetch_one(&mut *tx)
    .await?;

    tx.commit().await?;

    let cap = ctx.can_read_cost();
    let data: Vec<Value> = rows
        .iter()
        .map(|r| {
            let qty: Decimal = r.try_get("qty")?;
            let balance: Decimal = r.try_get("balance")?;
            let mut v = json!({
                "business_date": r.try_get::<NaiveDate, _>("business_date")?,
                "type": r.try_get::<String, _>("type")?,
                "qty_delta": qty_json(&qty),
                "balance": qty_json(&balance),
                "ref_type": r.try_get::<Option<String>, _>("ref_type")?,
                "ref_id": r.try_get::<Option<Uuid>, _>("ref_id")?,
                "note": r.try_get::<Option<String>, _>("note")?,
                "actor": r.try_get::<Option<Uuid>, _>("created_by")?.map(|u| {
                    json!({ "user_id": u, "role": r.try_get::<Option<String>, _>("actor_role").ok().flatten() })
                }),
                "created_at": r.try_get::<DateTime<Utc>, _>("created_at")?,
            });
            if cap {
                v["unit_cost"] = json!(r.try_get::<i64, _>("unit_cost")?);
            }
            Ok(v)
        })
        .collect::<ApiResult<Vec<_>>>()?;

    Ok(Json(json!({
        "rows": data,
        "closing_qty": qty_json(&closing),
        "negative_stock": closing < Decimal::ZERO,
    })))
}

/// Void of a sale posts one counter-entry per line (type `return`).
pub(crate) struct VoidReturn {
    pub item_id: Uuid,
    pub outlet_id: Uuid,
    pub qty: Decimal,
    pub unit_cost: i64,
    pub business_date: NaiveDate,
    pub sale_id: Uuid,
}

pub(crate) async fn post_void_return(
    tx: &mut PgConnection,
    actor: Uuid,
    v: &VoidReturn,
) -> ApiResult<Uuid> {
    post_move(
        tx,
        actor,
        &PostMove {
            item_id: v.item_id,
            outlet_id: v.outlet_id,
            qty: v.qty,
            unit_cost: v.unit_cost,
            kind: "return",
            ref_type: Some("sale_void".into()),
            ref_id: Some(v.sale_id),
            business_date: v.business_date,
            note: None,
            op_id: None,
        },
        None,
    )
    .await
}
