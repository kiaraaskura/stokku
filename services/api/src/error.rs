use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde_json::{json, Map, Value};

/// JSON error envelope, exactly as docs/API_CONTRACT.md "Errors":
/// `{ "error": { "code": "...", "message": "...", "fields": {...}? } }`
#[derive(Debug)]
pub enum ApiError {
    Unauthorized(String),
    Forbidden(String),
    NotFound(String),
    Validation {
        message: String,
        fields: Option<Map<String, Value>>,
    },
    Conflict(String),
    PeriodClosed(String),
    RateLimited,
    Internal(String),
}

impl ApiError {
    pub fn validation(message: impl Into<String>) -> Self {
        ApiError::Validation {
            message: message.into(),
            fields: None,
        }
    }

    pub fn validation_field(message: impl Into<String>, field: &str, detail: &str) -> Self {
        let mut fields = Map::new();
        fields.insert(field.to_string(), json!(detail));
        ApiError::Validation {
            message: message.into(),
            fields: Some(fields),
        }
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let (status, code, message, fields) = match &self {
            ApiError::Unauthorized(m) => {
                (StatusCode::UNAUTHORIZED, "unauthorized", m.clone(), None)
            }
            ApiError::Forbidden(m) => (StatusCode::FORBIDDEN, "forbidden", m.clone(), None),
            ApiError::NotFound(m) => (StatusCode::NOT_FOUND, "not_found", m.clone(), None),
            ApiError::Validation { message, fields } => (
                StatusCode::UNPROCESSABLE_ENTITY,
                "validation_failed",
                message.clone(),
                fields.clone(),
            ),
            ApiError::Conflict(m) => (StatusCode::CONFLICT, "conflict", m.clone(), None),
            ApiError::PeriodClosed(m) => (StatusCode::LOCKED, "period_closed", m.clone(), None),
            ApiError::RateLimited => (
                StatusCode::TOO_MANY_REQUESTS,
                "rate_limited",
                "Terlalu banyak percobaan, coba lagi dalam 1 menit".into(),
                None,
            ),
            ApiError::Internal(m) => {
                tracing::error!(internal = %m, "internal error");
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "internal",
                    "Kesalahan internal".into(),
                    None,
                )
            }
        };

        let mut err = json!({ "code": code, "message": message });
        if let Some(f) = fields {
            err["fields"] = Value::Object(f);
        }
        (status, Json(json!({ "error": err }))).into_response()
    }
}

fn friendly_unique(constraint: &str) -> Option<&'static str> {
    Some(match constraint {
        "user_app_email_key" => "Email sudah terdaftar",
        "item_sku_tenant_live_uq" => "SKU sudah dipakai item lain",
        "item_barcode_tenant_uq" => "Barcode sudah dipakai item lain",
        "category_tenant_id_name_key" => "Kategori dengan nama itu sudah ada",
        "membership_tenant_id_user_id_key" => "User sudah jadi anggota toko ini",
        _ => return None,
    })
}

fn friendly_check(constraint: &str) -> Option<&'static str> {
    Some(match constraint {
        "sale_line_discount_range" => "Diskon baris tidak boleh melebihi nilai baris",
        "cash_entry_amount_check" => "Jumlah uang harus lebih dari 0",
        "sale_total_check" => "Total penjualan tidak boleh negatif",
        "sale_discount_check" => "Diskon tidak boleh negatif",
        "sale_line_qty_check" => "Qty baris penjualan harus lebih dari 0",
        "sale_line_unit_price_check" => "Harga satuan tidak boleh negatif",
        "cash_entry_direction_check" => "Arah harus in atau out",
        "item_unit_factor_check" => "Faktor satuan harus lebih dari 0",
        "sale_payment_method_check" => "Metode pembayaran tidak valid",
        _ => return None,
    })
}

impl From<sqlx::Error> for ApiError {
    fn from(e: sqlx::Error) -> Self {
        let sqlx::Error::Database(db) = &e else {
            return match &e {
                sqlx::Error::RowNotFound => ApiError::NotFound("Tidak ditemukan".into()),
                _ => ApiError::Internal(format!("{e:#}")),
            };
        };
        let constraint = db.constraint().unwrap_or_default().to_string();
        let message = db.message().to_string();

        if message.contains("period_locked") {
            return ApiError::PeriodClosed(
                "Periode bulan itu sudah dikunci untuk penulisan non-owner".into(),
            );
        }

        match db.code().as_deref() {
            Some("23505") => ApiError::Conflict(
                friendly_unique(&constraint)
                    .map(|s| s.to_string())
                    .unwrap_or_else(|| format!("Data sudah ada: {message}")),
            ),
            Some("23514") => ApiError::validation(
                friendly_check(&constraint)
                    .map(|s| s.to_string())
                    .unwrap_or_else(|| format!("Nilai tidak valid: {message}")),
            ),
            Some("23503") => ApiError::validation(format!("Referensi tidak valid: {message}")),
            _ => ApiError::Internal(format!("{e:#}")),
        }
    }
}

pub type ApiResult<T> = Result<T, ApiError>;
