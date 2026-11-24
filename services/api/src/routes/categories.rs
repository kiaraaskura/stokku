use serde::Deserialize;
use serde_json::{json, Value};

use axum::extract::State;
use axum::Json;

use crate::ctx::{AuthCtx, Cap};
use crate::error::{ApiError, ApiResult};
use crate::state::AppState;
use crate::util::{begin_tx, now_v7};

/// GET /v1/categories — flat list.
pub async fn list(State(st): State<AppState>, ctx: AuthCtx) -> ApiResult<Json<Value>> {
    let mut tx = begin_tx(&st.pool, &ctx).await?;
    let rows: Vec<(uuid::Uuid, String, i32)> = sqlx::query_as(
        "select id, name, sort from category order by sort, name",
    )
    .fetch_all(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(Json(json!({
        "data": rows.iter().map(|(id, name, sort)| json!({
            "id": id, "name": name, "sort": sort
        })).collect::<Vec<_>>(),
        "next_cursor": null,
    })))
}

#[derive(Deserialize)]
pub struct CategoryReq {
    pub name: String,
    pub sort: Option<i32>,
}

/// POST /v1/categories — master data write, owner only.
pub async fn create(
    State(st): State<AppState>,
    ctx: AuthCtx,
    Json(body): Json<CategoryReq>,
) -> ApiResult<Json<Value>> {
    ctx.require(Cap::ItemWrite)?;
    if body.name.trim().is_empty() {
        return Err(ApiError::validation_field(
            "Nama kategori wajib diisi",
            "name",
            "tidak boleh kosong",
        ));
    }
    let id = now_v7();
    let mut tx = begin_tx(&st.pool, &ctx).await?;
    sqlx::query(
        "insert into category (id, tenant_id, name, sort)
         values ($1, current_setting('app.tenant_id')::uuid, $2, $3)",
    )
    .bind(id)
    .bind(body.name.trim())
    .bind(body.sort.unwrap_or(0))
    .execute(&mut *tx)
    .await?;
    let row: Option<(uuid::Uuid, String, i32)> = sqlx::query_as(
        "select id, name, sort from category where id = $1",
    )
    .bind(id)
    .fetch_optional(&mut *tx)
    .await?;
    tx.commit().await?;
    let (id, name, sort) = row.ok_or_else(|| ApiError::Internal("kategori hilang setelah insert".into()))?;
    Ok(Json(json!({ "id": id, "name": name, "sort": sort })))
}
