use chrono::{NaiveDate, Utc};
use rust_decimal::Decimal;
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::PgConnection;
use uuid::Uuid;

use crate::error::{ApiError, ApiResult};

/// UUIDv7 app-side (monotonic, sortable), per docs/DECISIONS.md.
pub fn now_v7() -> Uuid {
    Uuid::now_v7()
}

/// Today's business date in the outlet timezone. MVP outlets are
/// Asia/Jakarta (+07) — the seeded default in docs/DATA_MODEL.md.
pub fn today_jakarta() -> NaiveDate {
    (Utc::now() + chrono::Duration::hours(7)).date_naive()
}

pub fn parse_date(s: &str) -> ApiResult<NaiveDate> {
    NaiveDate::parse_from_str(s, "%Y-%m-%d")
        .map_err(|_| ApiError::validation_field("Tanggal tidak valid", "business_date", "format YYYY-MM-DD"))
}

/// Deserialize a qty from a JSON number or a decimal string (API contract:
/// "decimal string or number with max 3 dp").
pub fn de_qty<'de, D>(d: D) -> Result<Decimal, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let v = Value::deserialize(d)?;
    let s = match &v {
        Value::Number(n) => n.to_string(),
        Value::String(s) => s.trim().replace(',', "."),
        _ => return Err(serde::de::Error::custom("qty harus angka atau string desimal")),
    };
    let dec = Decimal::from_str_exact(&s)
        .map_err(|_| serde::de::Error::custom("qty bukan angka desimal yang valid"))?;
    if dec.scale() > 3 {
        return Err(serde::de::Error::custom("qty maksimal 3 angka desimal"));
    }
    if dec.abs() >= Decimal::from_str_exact("100000000000000").unwrap_or(Decimal::MAX) {
        return Err(serde::de::Error::custom("qty terlalu besar (maks NUMERIC(14,3))"));
    }
    Ok(dec)
}

/// Emit a qty as a JSON number (exact for integers; shortest round-trip
/// otherwise). Keeps contract examples like `"qty": 2` working.
pub fn qty_json(d: &Decimal) -> Value {
    let s = d.normalize().to_string();
    match serde_json::from_str::<Value>(&s) {
        Ok(v) => v,
        Err(_) => json!(s),
    }
}

/// Round a decimal rupiah amount to an integer (half away from zero).
pub fn dec_to_rupiah(d: &Decimal) -> i64 {
    let r = d.round();
    i64::try_from(r.mantissa()).unwrap_or(0)
}

/// Default outlet for the current tenant (single-outlet MVP).
pub async fn default_outlet_id(tx: &mut PgConnection) -> ApiResult<Uuid> {
    let id: Option<Uuid> = sqlx::query_scalar(
        "select id from outlet order by created_at, id limit 1",
    )
    .fetch_optional(tx)
    .await?;
    id.ok_or_else(|| ApiError::NotFound("Outlet tidak ditemukan".into()))
}

/// Set the RLS context for this transaction (docs/DATA_MODEL.md §4).
pub async fn set_app_context(
    tx: &mut PgConnection,
    tenant: Option<Uuid>,
    user: Option<Uuid>,
) -> ApiResult<()> {
    sqlx::query("select set_app_context($1, $2)")
        .bind(tenant)
        .bind(user)
        .execute(tx)
        .await?;
    Ok(())
}

/// Begin a transaction with the tenant/user context applied.
pub async fn begin_tx(
    pool: &sqlx::PgPool,
    ctx: &crate::ctx::AuthCtx,
) -> ApiResult<sqlx::Transaction<'static, sqlx::Postgres>> {
    let mut tx = pool.begin().await?;
    set_app_context(&mut tx, Some(ctx.tenant_id), Some(ctx.user_id)).await?;
    Ok(tx)
}
