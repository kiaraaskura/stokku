//! Contacts and their money: payables (utang ke pemasok) and receivables
//! (piutang pelanggan). T-133.
//!
//! Money rules from DECISIONS.md apply: integer rupiah, `business_date`
//! separate from `created_at`, `tenant_id` everywhere, RLS does the scoping.
//! Every payment that moves cash posts a `cash_entry` — there is no second
//! accounting path: `sale`/`cash_entry` remain the only things the report
//! views read.
//!
//! Capability: contacts are operational, so staff may read and write them.
//! Payables and receivables use the same `cash.write` capability as the cash
//! book, because recording a payment against them is a cash-book write.

use chrono::{DateTime, NaiveDate, Utc};
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::Row;
use uuid::Uuid;

use axum::extract::{Path, Query, State};
use axum::Json;

use crate::ctx::{AuthCtx, Cap};
use crate::error::{ApiError, ApiResult};
use crate::state::AppState;
use crate::util::{begin_tx, default_outlet_id, now_v7, parse_date, today_jakarta};

const DEFAULT_PAYABLE_CATEGORY: &str = "pembelian_stok";
const DEFAULT_RECEIVABLE_CATEGORY: &str = "penjualan";

fn contact_json(row: &sqlx::postgres::PgRow) -> ApiResult<Value> {
    Ok(json!({
        "id": row.try_get::<Uuid, _>("id")?,
        "type": row.try_get::<String, _>("type")?,
        "name": row.try_get::<String, _>("name")?,
        "phone": row.try_get::<Option<String>, _>("phone")?,
        "created_at": row.try_get::<DateTime<Utc>, _>("created_at")?,
    }))
}

fn bill_json(row: &sqlx::postgres::PgRow, kind: &str) -> ApiResult<Value> {
    let amount: i64 = row.try_get("amount")?;
    let paid: i64 = row.try_get("paid_amount")?;
    Ok(json!({
        "id": row.try_get::<Uuid, _>("id")?,
        "type": kind,
        "contact_id": row.try_get::<Uuid, _>("contact_id")?,
        "amount": amount,
        "paid_amount": paid,
        "outstanding": amount - paid,
        "due_date": row.try_get::<Option<NaiveDate>, _>("due_date")?,
        "created_at": row.try_get::<DateTime<Utc>, _>("created_at")?,
    }))
}

// ---------------------------------------------------------------- contacts

#[derive(Deserialize)]
pub struct ContactListQuery {
    #[serde(rename = "type")]
    pub kind: Option<String>,
    pub q: Option<String>,
}

/// GET /v1/contacts?type=customer|supplier&q=
pub async fn list(
    State(st): State<AppState>,
    ctx: AuthCtx,
    Query(q): Query<ContactListQuery>,
) -> ApiResult<Json<Value>> {
    let kind = q.kind.as_deref().map(str::trim).filter(|s| !s.is_empty());
    if let Some(k) = kind {
        validate_kind(k)?;
    }
    let search =
        q.q.as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(|s| format!("%{s}%"));

    let mut tx = begin_tx(&st.pool, &ctx).await?;
    let rows = sqlx::query(
        "select id, type, name, phone, created_at
         from contact
         where ($1::text is null or type = $1)
           and ($2::text is null or name ilike $2 or coalesce(phone, '') ilike $2)
         order by name, id",
    )
    .bind(kind)
    .bind(search)
    .fetch_all(&mut *tx)
    .await?;

    let mut out = Vec::with_capacity(rows.len());
    for r in &rows {
        out.push(contact_json(r)?);
    }
    tx.commit().await?;
    Ok(Json(json!({ "items": out })))
}

#[derive(Deserialize)]
pub struct ContactReq {
    #[serde(rename = "type")]
    pub kind: String,
    pub name: String,
    pub phone: Option<String>,
}

/// POST /v1/contacts
pub async fn create(
    State(st): State<AppState>,
    ctx: AuthCtx,
    Json(body): Json<ContactReq>,
) -> ApiResult<Json<Value>> {
    let kind = body.kind.trim();
    validate_kind(kind)?;
    let name = body.name.trim();
    if name.is_empty() {
        return Err(ApiError::validation_field(
            "Nama kontak wajib diisi",
            "name",
            "tidak boleh kosong",
        ));
    }

    let mut tx = begin_tx(&st.pool, &ctx).await?;
    let id = now_v7();
    sqlx::query(
        "insert into contact (id, tenant_id, type, name, phone)
         values ($1, current_setting('app.tenant_id')::uuid, $2, $3, $4)",
    )
    .bind(id)
    .bind(kind)
    .bind(name)
    .bind(
        body.phone
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty()),
    )
    .execute(&mut *tx)
    .await?;

    let row = sqlx::query("select id, type, name, phone, created_at from contact where id = $1")
        .bind(id)
        .fetch_one(&mut *tx)
        .await?;
    let v = contact_json(&row)?;
    tx.commit().await?;
    Ok(Json(v))
}

#[derive(Deserialize)]
pub struct ContactPatch {
    pub name: Option<String>,
    pub phone: Option<String>,
}

/// PATCH /v1/contacts/{id} — name and phone only. Changing a type after the
/// contact has been used would rewrite history, so it is not offered.
pub async fn update(
    State(st): State<AppState>,
    ctx: AuthCtx,
    Path(id): Path<Uuid>,
    Json(body): Json<ContactPatch>,
) -> ApiResult<Json<Value>> {
    let mut tx = begin_tx(&st.pool, &ctx).await?;
    let exists: Option<Uuid> = sqlx::query_scalar("select id from contact where id = $1")
        .bind(id)
        .fetch_optional(&mut *tx)
        .await?;
    if exists.is_none() {
        return Err(ApiError::NotFound("Kontak tidak ditemukan".into()));
    }

    if let Some(name) = &body.name {
        let name = name.trim();
        if name.is_empty() {
            return Err(ApiError::validation_field(
                "Nama kontak wajib diisi",
                "name",
                "tidak boleh kosong",
            ));
        }
        sqlx::query("update contact set name = $1 where id = $2")
            .bind(name)
            .bind(id)
            .execute(&mut *tx)
            .await?;
    }
    if let Some(phone) = &body.phone {
        let phone = phone.trim();
        sqlx::query("update contact set phone = $1 where id = $2")
            .bind(if phone.is_empty() { None } else { Some(phone) })
            .bind(id)
            .execute(&mut *tx)
            .await?;
    }

    let row = sqlx::query("select id, type, name, phone, created_at from contact where id = $1")
        .bind(id)
        .fetch_one(&mut *tx)
        .await?;
    let v = contact_json(&row)?;
    tx.commit().await?;
    Ok(Json(v))
}

/// DELETE /v1/contacts/{id} — refused once the contact is on any transaction,
/// so the ledger never points at a name that vanished.
pub async fn remove(
    State(st): State<AppState>,
    ctx: AuthCtx,
    Path(id): Path<Uuid>,
) -> ApiResult<Json<Value>> {
    let mut tx = begin_tx(&st.pool, &ctx).await?;
    let exists: Option<Uuid> = sqlx::query_scalar("select id from contact where id = $1")
        .bind(id)
        .fetch_optional(&mut *tx)
        .await?;
    if exists.is_none() {
        return Err(ApiError::NotFound("Kontak tidak ditemukan".into()));
    }

    let used: i64 = sqlx::query_scalar(
        "select (select count(*) from payable where contact_id = $1)
              + (select count(*) from receivable where contact_id = $1)
              + (select count(*) from sale where customer_id = $1)",
    )
    .bind(id)
    .fetch_one(&mut *tx)
    .await?;
    if used > 0 {
        return Err(ApiError::Conflict(
            "Kontak sudah dipakai di transaksi, jadi tidak bisa dihapus".into(),
        ));
    }

    sqlx::query("delete from contact where id = $1")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(Json(json!({ "deleted": true, "id": id })))
}

fn validate_kind(kind: &str) -> ApiResult<()> {
    if kind == "customer" || kind == "supplier" {
        Ok(())
    } else {
        Err(ApiError::validation_field(
            "Jenis kontak harus customer atau supplier",
            "type",
            "customer | supplier",
        ))
    }
}

// ------------------------------------------------------- payables/receivables

#[derive(Deserialize)]
pub struct BillListQuery {
    pub contact_id: Option<Uuid>,
    pub open: Option<bool>,
}

#[derive(Deserialize)]
pub struct BillReq {
    pub contact_id: Uuid,
    pub amount: i64,
    pub due_date: Option<String>,
    pub sale_id: Option<Uuid>,
}

#[derive(Deserialize)]
pub struct PaymentReq {
    pub amount: i64,
    pub business_date: Option<String>,
    pub method: Option<String>,
    pub category: Option<String>,
    pub outlet_id: Option<Uuid>,
    pub note: Option<String>,
    pub op_id: Option<Uuid>,
}

/// GET /v1/payables?contact_id=&open=true
pub async fn list_payables(
    State(st): State<AppState>,
    ctx: AuthCtx,
    Query(q): Query<BillListQuery>,
) -> ApiResult<Json<Value>> {
    list_bills(st, ctx, q, "payable").await
}

/// GET /v1/receivables?contact_id=&open=true
pub async fn list_receivables(
    State(st): State<AppState>,
    ctx: AuthCtx,
    Query(q): Query<BillListQuery>,
) -> ApiResult<Json<Value>> {
    list_bills(st, ctx, q, "receivable").await
}

async fn list_bills(
    st: AppState,
    ctx: AuthCtx,
    q: BillListQuery,
    table: &str,
) -> ApiResult<Json<Value>> {
    let mut tx = begin_tx(&st.pool, &ctx).await?;
    let sql = format!(
        "select id, contact_id, amount, paid_amount, due_date, created_at
         from {table}
         where ($1::uuid is null or contact_id = $1)
           and ($2::bool is not true or paid_amount < amount)
         order by coalesce(due_date, date '9999-12-31'), created_at, id"
    );
    let rows = sqlx::query(&sql)
        .bind(q.contact_id)
        .bind(q.open)
        .fetch_all(&mut *tx)
        .await?;

    let mut items = Vec::with_capacity(rows.len());
    let mut outstanding: i64 = 0;
    for r in &rows {
        let v = bill_json(r, table)?;
        outstanding += v["outstanding"].as_i64().unwrap_or(0);
        items.push(v);
    }
    tx.commit().await?;
    Ok(Json(
        json!({ "items": items, "outstanding_total": outstanding }),
    ))
}

/// POST /v1/payables
pub async fn create_payable(
    State(st): State<AppState>,
    ctx: AuthCtx,
    Json(body): Json<BillReq>,
) -> ApiResult<Json<Value>> {
    create_bill(st, ctx, body, "payable").await
}

/// POST /v1/receivables
pub async fn create_receivable(
    State(st): State<AppState>,
    ctx: AuthCtx,
    Json(body): Json<BillReq>,
) -> ApiResult<Json<Value>> {
    create_bill(st, ctx, body, "receivable").await
}

async fn create_bill(
    st: AppState,
    ctx: AuthCtx,
    body: BillReq,
    table: &str,
) -> ApiResult<Json<Value>> {
    ctx.require(Cap::CashWrite)?;
    if body.amount <= 0 {
        return Err(ApiError::validation_field(
            "Jumlah harus lebih dari 0",
            "amount",
            "min 1",
        ));
    }
    let due_date = match &body.due_date {
        Some(s) => Some(parse_date(s)?),
        None => None,
    };

    let mut tx = begin_tx(&st.pool, &ctx).await?;
    let contact_type: Option<String> = sqlx::query_scalar("select type from contact where id = $1")
        .bind(body.contact_id)
        .fetch_optional(&mut *tx)
        .await?;
    let contact_type =
        contact_type.ok_or_else(|| ApiError::NotFound("Kontak tidak ditemukan".into()))?;
    let wanted = if table == "payable" {
        "supplier"
    } else {
        "customer"
    };
    if contact_type != wanted {
        return Err(ApiError::validation_field(
            if table == "payable" {
                "Utang hanya untuk kontak pemasok"
            } else {
                "Piutang hanya untuk kontak pelanggan"
            },
            "contact_id",
            wanted,
        ));
    }

    let id = now_v7();
    if table == "payable" {
        sqlx::query(
            "insert into payable (id, tenant_id, contact_id, amount, due_date)
             values ($1, current_setting('app.tenant_id')::uuid, $2, $3, $4)",
        )
        .bind(id)
        .bind(body.contact_id)
        .bind(body.amount)
        .bind(due_date)
        .execute(&mut *tx)
        .await?;
    } else {
        sqlx::query(
            "insert into receivable (id, tenant_id, contact_id, sale_id, amount, due_date)
             values ($1, current_setting('app.tenant_id')::uuid, $2, $3, $4, $5)",
        )
        .bind(id)
        .bind(body.contact_id)
        .bind(body.sale_id)
        .bind(body.amount)
        .bind(due_date)
        .execute(&mut *tx)
        .await?;
    }

    let row = sqlx::query(&format!(
        "select id, contact_id, amount, paid_amount, due_date, created_at from {table} where id = $1"
    ))
    .bind(id)
    .fetch_one(&mut *tx)
    .await?;
    let v = bill_json(&row, table)?;
    tx.commit().await?;
    Ok(Json(v))
}

/// POST /v1/payables/{id}/payments — money leaves the drawer.
pub async fn pay_payable(
    State(st): State<AppState>,
    ctx: AuthCtx,
    Path(id): Path<Uuid>,
    Json(body): Json<PaymentReq>,
) -> ApiResult<Json<Value>> {
    let default_category = DEFAULT_PAYABLE_CATEGORY;
    pay_bill(st, ctx, id, body, "payable", "out", default_category).await
}

/// POST /v1/receivables/{id}/payments — money comes in.
pub async fn pay_receivable(
    State(st): State<AppState>,
    ctx: AuthCtx,
    Path(id): Path<Uuid>,
    Json(body): Json<PaymentReq>,
) -> ApiResult<Json<Value>> {
    let default_category = DEFAULT_RECEIVABLE_CATEGORY;
    pay_bill(st, ctx, id, body, "receivable", "in", default_category).await
}

async fn pay_bill(
    st: AppState,
    ctx: AuthCtx,
    id: Uuid,
    body: PaymentReq,
    table: &str,
    direction: &str,
    default_category: &str,
) -> ApiResult<Json<Value>> {
    ctx.require(Cap::CashWrite)?;
    if body.amount <= 0 {
        return Err(ApiError::validation_field(
            "Jumlah pembayaran harus lebih dari 0",
            "amount",
            "min 1",
        ));
    }
    let business_date = match &body.business_date {
        Some(s) => parse_date(s)?,
        None => today_jakarta(),
    };
    let category = body
        .category
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(default_category);

    let mut tx = begin_tx(&st.pool, &ctx).await?;

    // Lock the bill so two payments cannot both pass the overpayment check.
    let row = sqlx::query(&format!(
        "select id, contact_id, amount, paid_amount, due_date, created_at
         from {table} where id = $1 for update"
    ))
    .bind(id)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(|| ApiError::NotFound("Tagihan tidak ditemukan".into()))?;

    let total: i64 = row.try_get("amount")?;
    let paid: i64 = row.try_get("paid_amount")?;
    let remaining = total - paid;
    if body.amount > remaining {
        return Err(ApiError::validation_field(
            format!("Jumlah pembayaran melebihi sisa tagihan (sisa {remaining} rupiah)"),
            "amount",
            &format!("maks {remaining}"),
        ));
    }

    let outlet_id = match body.outlet_id {
        Some(o) => o,
        None => default_outlet_id(&mut tx).await?,
    };

    // The cash book is the only place money is recorded; link it to the bill.
    let cash_id = now_v7();
    sqlx::query(
        "insert into cash_entry
           (id, tenant_id, outlet_id, direction, amount, category, method, ref_type, ref_id,
            business_date, note, op_id, created_by)
         values ($1, current_setting('app.tenant_id')::uuid, $2, $3, $4, $5, $6, $7, $8, $9,
                 $10, $11, $12)",
    )
    .bind(cash_id)
    .bind(outlet_id)
    .bind(direction)
    .bind(body.amount)
    .bind(category)
    .bind(body.method.as_deref())
    .bind(if table == "payable" {
        "payable_payment"
    } else {
        "receivable_payment"
    })
    .bind(id)
    .bind(business_date)
    .bind(body.note.as_deref())
    .bind(body.op_id)
    .bind(ctx.user_id)
    .execute(&mut *tx)
    .await?;

    sqlx::query(&format!(
        "update {table} set paid_amount = paid_amount + $1 where id = $2"
    ))
    .bind(body.amount)
    .bind(id)
    .execute(&mut *tx)
    .await?;

    let row = sqlx::query(&format!(
        "select id, contact_id, amount, paid_amount, due_date, created_at from {table} where id = $1"
    ))
    .bind(id)
    .fetch_one(&mut *tx)
    .await?;
    let v = bill_json(&row, table)?;
    tx.commit().await?;

    Ok(Json(json!({
        "bill": v,
        "cash_entry_id": cash_id,
        "settled": v["outstanding"].as_i64() == Some(0),
    })))
}
