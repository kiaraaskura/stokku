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
use crate::util::begin_tx;

/// GET /v1/outlets/{id}/qris — any member of the tenant (staff needs it
/// for checkout); cost fields are not involved.
pub async fn get_settings(
    State(st): State<AppState>,
    ctx: AuthCtx,
    Path(outlet_id): Path<Uuid>,
) -> ApiResult<Json<Value>> {
    let mut tx = begin_tx(&st.pool, &ctx).await?;
    let row = sqlx::query(
        "select id, qris_mode, qris_image_key, qris_payload, mdr_pct from outlet where id = $1",
    )
    .bind(outlet_id)
    .fetch_optional(&mut *tx)
    .await?;
    let row = row.ok_or_else(|| ApiError::NotFound("Outlet tidak ditemukan".into()))?;
    tx.commit().await?;

    let mdr: Decimal = row.try_get("mdr_pct")?;
    Ok(Json(json!({
        "outlet_id": outlet_id,
        "mode": row.try_get::<String, _>("qris_mode")?,
        "image_url": row.try_get::<Option<String>, _>("qris_image_key")?,
        "payload": row.try_get::<Option<String>, _>("qris_payload")?,
        "mdr_pct": crate::util::qty_json(&mdr),
    })))
}

#[derive(Deserialize)]
pub struct QrisSettingsReq {
    pub mode: String,
    pub image_url: Option<String>,
    pub payload: Option<String>,
    pub mdr_pct: Option<Decimal>,
}

/// A well-formed EMVCo TLV walk: 2-digit tag, 2-digit length, value.
/// Returns the (tag, value) pairs; the CRC tag "63" must be last.
fn parse_tlv(payload: &str) -> ApiResult<Vec<(String, String)>> {
    let bad = |why: &str| {
        ApiError::validation_field(
            format!("Payload QRIS tidak valid: {why}"),
            "payload",
            "format TLV EMVCo",
        )
    };
    let b = payload.as_bytes();
    let mut out = Vec::new();
    let mut i = 0usize;
    while i < b.len() {
        if i + 4 > b.len() {
            return Err(bad("segmen terlalu pendek untuk tag dan panjang"));
        }
        let tag = &payload[i..i + 2];
        if !tag.bytes().all(|c| c.is_ascii_digit()) {
            return Err(bad("tag harus dua digit angka"));
        }
        let len_s = &payload[i + 2..i + 4];
        if !len_s.bytes().all(|c| c.is_ascii_digit()) {
            return Err(bad("panjang harus dua digit angka"));
        }
        let len: usize = len_s.parse().map_err(|_| bad("panjang bukan angka"))?;
        let v_end = i + 4 + len;
        if v_end > b.len() {
            return Err(bad("nilai lebih pendek dari panjang yang dinyatakan"));
        }
        out.push((tag.to_string(), payload[i + 4..v_end].to_string()));
        i = v_end;
    }
    if out.is_empty() {
        return Err(bad("payload kosong"));
    }
    if out.first().map(|(t, _)| t.as_str()) != Some("00") {
        return Err(bad("tag 00 (payload format indicator) wajib ada di awal"));
    }
    if out.last().map(|(t, _)| t.as_str()) != Some("63") {
        return Err(bad("tag 63 (CRC) wajib ada di akhir"));
    }
    if out.last().map(|(_, v)| v.len()) != Some(4) {
        return Err(bad("nilai CRC harus 4 karakter hex"));
    }
    Ok(out)
}

/// Validate structure in Rust, then the CRC with DB's qris_crc16() —
/// one CRC implementation, owned by DB.
async fn validate_payload(tx: &mut sqlx::PgConnection, payload: &str) -> ApiResult<()> {
    parse_tlv(payload)?;
    if payload.len() < 8 {
        return Err(ApiError::validation_field(
            "Payload QRIS terlalu pendek untuk memuat CRC",
            "payload",
            "minimal tag 63 + CRC",
        ));
    }
    let body_len = payload.len() - 4;
    let (body, crc) = payload.split_at(body_len);
    let expected: String = sqlx::query_scalar("select qris_crc16($1)")
        .bind(body)
        .fetch_one(tx)
        .await?;
    if !crc.eq_ignore_ascii_case(&expected) {
        return Err(ApiError::validation_field(
            format!("CRC QRIS salah: dihitung {expected}, tertulis {crc}"),
            "payload",
            "CRC16 tidak cocok",
        ));
    }
    Ok(())
}

/// PUT /v1/outlets/{id}/qris — owner only.
pub async fn put_settings(
    State(st): State<AppState>,
    ctx: AuthCtx,
    Path(outlet_id): Path<Uuid>,
    Json(body): Json<QrisSettingsReq>,
) -> ApiResult<Json<Value>> {
    ctx.require_owner()?;
    if !matches!(
        body.mode.as_str(),
        "none" | "static_image" | "static_payload"
    ) {
        return Err(ApiError::validation_field(
            "Mode QRIS tidak valid",
            "mode",
            "none | static_image | static_payload",
        ));
    }
    if let Some(mdr) = body.mdr_pct {
        if mdr < Decimal::ZERO || mdr > Decimal::from(100) {
            return Err(ApiError::validation_field(
                "MDR harus di antara 0 dan 100 persen",
                "mdr_pct",
                "0..100",
            ));
        }
    }
    let payload = body
        .payload
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty());
    let image_url = body
        .image_url
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty());

    let mut tx = begin_tx(&st.pool, &ctx).await?;
    let exists: Option<Uuid> = sqlx::query_scalar("select id from outlet where id = $1")
        .bind(outlet_id)
        .fetch_optional(&mut *tx)
        .await?;
    if exists.is_none() {
        return Err(ApiError::NotFound("Outlet tidak ditemukan".into()));
    }

    let mut stored_payload: Option<String> = None;
    match body.mode.as_str() {
        "static_payload" => {
            let Some(p) = payload else {
                return Err(ApiError::validation_field(
                    "Mode static_payload butuh payload QRIS",
                    "payload",
                    "tempel payload dari aplikasi QRIS Anda",
                ));
            };
            validate_payload(&mut tx, p).await?;
            stored_payload = Some(p.to_string());
        }
        "static_image" => {
            // a key must be present; image readability is a UI concern
            let _ = image_url.as_ref().ok_or_else(|| {
                ApiError::validation_field(
                    "Mode static_image butuh gambar QRIS",
                    "image_url",
                    "unggah gambar QRIS Anda",
                )
            })?;
        }
        _ => {}
    }

    sqlx::query(
        "update outlet set qris_mode = $2,
                           qris_payload = $3,
                           qris_image_key = $4,
                           mdr_pct = coalesce($5, mdr_pct)
         where id = $1",
    )
    .bind(outlet_id)
    .bind(&body.mode)
    .bind(stored_payload.as_deref())
    .bind(image_url)
    .bind(body.mdr_pct)
    .execute(&mut *tx)
    .await?;

    let row = sqlx::query(
        "select id, qris_mode, qris_image_key, qris_payload, mdr_pct from outlet where id = $1",
    )
    .bind(outlet_id)
    .fetch_one(&mut *tx)
    .await?;
    tx.commit().await?;

    let mdr: Decimal = row.try_get("mdr_pct")?;
    Ok(Json(json!({
        "outlet_id": outlet_id,
        "mode": row.try_get::<String, _>("qris_mode")?,
        "image_url": row.try_get::<Option<String>, _>("qris_image_key")?,
        "payload": row.try_get::<Option<String>, _>("qris_payload")?,
        "mdr_pct": crate::util::qty_json(&mdr),
    })))
}

#[derive(Deserialize)]
pub struct QrisConfirmReq {
    pub amount_gross: i64,
    pub mdr_pct: Option<Decimal>,
    pub paid_at: Option<String>,
}

/// POST /v1/sales/{id}/qris/confirm — Tier 0: mark the sale's payment
/// paid with gross/MDR/net. Idempotent per sale: a second confirm is 409,
/// never a second paid payment.
pub async fn confirm(
    State(st): State<AppState>,
    ctx: AuthCtx,
    Path(sale_id): Path<Uuid>,
    Json(body): Json<QrisConfirmReq>,
) -> ApiResult<Json<Value>> {
    ctx.require(Cap::SalesWrite)?;
    if body.amount_gross < 0 {
        return Err(ApiError::validation_field(
            "Jumlah kotor tidak boleh negatif",
            "amount_gross",
            "min 0",
        ));
    }
    if let Some(mdr) = body.mdr_pct {
        if mdr < Decimal::ZERO || mdr > Decimal::from(100) {
            return Err(ApiError::validation_field(
                "MDR harus di antara 0 dan 100 persen",
                "mdr_pct",
                "0..100",
            ));
        }
    }
    let paid_at = match &body.paid_at {
        Some(s) => chrono::DateTime::parse_from_rfc3339(s)
            .map(|d| d.with_timezone(&chrono::Utc))
            .map_err(|_| {
                ApiError::validation_field(
                    "Waktu bayar tidak valid",
                    "paid_at",
                    "ISO-8601, contoh 2026-11-25T10:00:00Z",
                )
            })?,
        None => chrono::Utc::now(),
    };

    let mut tx = begin_tx(&st.pool, &ctx).await?;
    let sale = sqlx::query(
        "select id, outlet_id, voided_at, paid, payment_method from sale where id = $1",
    )
    .bind(sale_id)
    .fetch_optional(&mut *tx)
    .await?;
    let sale = sale.ok_or_else(|| ApiError::NotFound("Penjualan tidak ditemukan".into()))?;
    if sale
        .try_get::<Option<chrono::DateTime<chrono::Utc>>, _>("voided_at")?
        .is_some()
    {
        return Err(ApiError::Conflict(
            "Penjualan ini sudah di-void, tidak bisa dikonfirmasi".into(),
        ));
    }

    // exactly one paid payment per sale (payment_one_paid_uq)
    let payment: Option<(Uuid, String)> = sqlx::query_as(
        "select id, status from payment where sale_id = $1 order by created_at limit 1",
    )
    .bind(sale_id)
    .fetch_optional(&mut *tx)
    .await?;
    let payment_id = match payment {
        Some((_id, status)) if status == "paid" => {
            return Err(ApiError::Conflict(
                "Pembayaran QRIS untuk penjualan ini sudah dikonfirmasi".into(),
            ))
        }
        Some((id, _)) => id,
        None => crate::util::now_v7(),
    };
    let had_payment = payment.is_some();

    // MDR: body overrides, else the outlet's setting
    let mdr_pct: Decimal = match body.mdr_pct {
        Some(m) => m,
        None => {
            let m: Decimal = sqlx::query_scalar("select mdr_pct from outlet where id = $1")
                .bind(sale.try_get::<Uuid, _>("outlet_id")?)
                .fetch_one(&mut *tx)
                .await?;
            m
        }
    };
    // net = gross − round(gross * mdr_pct / 100), rupiah integers
    let mdr_amount = crate::util::dec_to_rupiah(
        &(Decimal::from(body.amount_gross) * mdr_pct / Decimal::from(100)),
    );
    let mdr_amount = mdr_amount.max(0);
    let amount_net = body.amount_gross - mdr_amount;
    if amount_net < 0 {
        return Err(ApiError::validation("MDR lebih besar dari jumlah kotor"));
    }

    if !had_payment {
        sqlx::query(
            "insert into payment (id, tenant_id, sale_id, method, amount_gross, mdr_amount,
                                  amount_net, status, paid_at, confirmed_by)
             values ($1, current_setting('app.tenant_id')::uuid, $2, 'qris', $3, $4, $5,
                     'paid', $6, $7)",
        )
        .bind(payment_id)
        .bind(sale_id)
        .bind(body.amount_gross)
        .bind(mdr_amount)
        .bind(amount_net)
        .bind(paid_at)
        .bind(ctx.user_id)
        .execute(&mut *tx)
        .await?;
    } else {
        sqlx::query(
            "update payment set method = 'qris', amount_gross = $2, mdr_amount = $3,
                                amount_net = $4, status = 'paid', paid_at = $5, confirmed_by = $6
             where id = $1",
        )
        .bind(payment_id)
        .bind(body.amount_gross)
        .bind(mdr_amount)
        .bind(amount_net)
        .bind(paid_at)
        .bind(ctx.user_id)
        .execute(&mut *tx)
        .await?;
    }

    // money arrived: the sale is paid now (cash entry stays a sale-time
    // concern; QRIS money is bank money in Tier 0)
    sqlx::query("update sale set paid = true where id = $1 and paid = false")
        .bind(sale_id)
        .execute(&mut *tx)
        .await?;

    let row = sqlx::query(
        "select id, sale_id, method, amount_gross, mdr_amount, amount_net, status, paid_at
         from payment where id = $1",
    )
    .bind(payment_id)
    .fetch_one(&mut *tx)
    .await?;
    tx.commit().await?;

    Ok(Json(json!({
        "payment": {
            "id": row.try_get::<Uuid, _>("id")?,
            "sale_id": row.try_get::<Uuid, _>("sale_id")?,
            "method": row.try_get::<String, _>("method")?,
            "amount_gross": row.try_get::<i64, _>("amount_gross")?,
            "mdr_amount": row.try_get::<i64, _>("mdr_amount")?,
            "amount_net": row.try_get::<i64, _>("amount_net")?,
            "status": row.try_get::<String, _>("status")?,
            "paid_at": row.try_get::<chrono::DateTime<chrono::Utc>, _>("paid_at")?,
        }
    })))
}
