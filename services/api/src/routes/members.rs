//! Staff membership (T-140).
//!
//! The owner invites an email and shares a one-time code; the helper accepts it
//! and becomes staff. There is no mail server in the MVP, and a warung onboards
//! a helper in person or over WhatsApp, so the code is returned once to the
//! owner and never stored in clear.
//!
//! Security shape, matching `refresh_token`:
//!  * only the SHA-256 of the code is stored;
//!  * single use, 7 days, revocable;
//!  * role is always `staff` — an invite can never mint a second owner;
//!  * accept runs before the person has a tenant, so the lookup goes through
//!    the definer function `auth_lookup_invite` (pinned search_path).
//!
//! Removing a member never deletes their `user_app` row: their name stays
//! attached to the sales and cash entries they posted.

use chrono::{DateTime, Duration, Utc};
use rand::RngCore;
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use sqlx::Row;
use uuid::Uuid;

use axum::extract::{Path, State};
use axum::Json;

use crate::auth::{hash_password, verify_password};
use crate::ctx::{AuthCtx, Cap};
use crate::error::{ApiError, ApiResult};
use crate::state::AppState;
use crate::util::{begin_tx, now_v7, set_app_context};

const INVITE_DAYS: i64 = 7;

fn new_code() -> String {
    let mut bytes = [0u8; 24];
    rand::rngs::OsRng.fill_bytes(&mut bytes);
    hex::encode(bytes)
}

fn code_hash(code: &str) -> String {
    hex::encode(Sha256::digest(code.as_bytes()))
}

/// GET /v1/members — owner only.
pub async fn list_members(State(st): State<AppState>, ctx: AuthCtx) -> ApiResult<Json<Value>> {
    ctx.require(Cap::MemberManage)?;
    let mut tx = begin_tx(&st.pool, &ctx).await?;
    let rows = sqlx::query(
        "select user_id, name, email, role, since
         from auth_members_of_tenant(current_setting('app.tenant_id')::uuid)",
    )
    .fetch_all(&mut *tx)
    .await?;
    let mut items = Vec::with_capacity(rows.len());
    for r in &rows {
        items.push(json!({
            "user_id": r.try_get::<Uuid, _>("user_id")?,
            "name": r.try_get::<String, _>("name")?,
            "email": r.try_get::<String, _>("email")?,
            "role": r.try_get::<String, _>("role")?,
            "since": r.try_get::<DateTime<Utc>, _>("since")?,
        }));
    }
    tx.commit().await?;
    Ok(Json(json!({ "items": items })))
}

#[derive(Deserialize)]
pub struct InviteReq {
    pub email: String,
}

/// POST /v1/members/invites — the code comes back exactly once.
pub async fn create_invite(
    State(st): State<AppState>,
    ctx: AuthCtx,
    Json(body): Json<InviteReq>,
) -> ApiResult<Json<Value>> {
    ctx.require(Cap::MemberManage)?;
    let email = body.email.trim().to_lowercase();
    if !email.contains('@') || email.len() < 5 {
        return Err(ApiError::validation_field(
            "Email tidak valid",
            "email",
            "harus alamat email",
        ));
    }

    let mut tx = begin_tx(&st.pool, &ctx).await?;

    // Already in this shop? Sending an invite would only confuse.
    // user_app is self-only under RLS, so resolve the account through the
    // definer helper and then check membership, which is tenant-visible.
    let known_user: Option<Uuid> = sqlx::query_scalar("select id from auth_find_user($1)")
        .bind(&email)
        .fetch_optional(&mut *tx)
        .await?;
    let already: Option<Uuid> = match known_user {
        Some(u) => {
            sqlx::query_scalar("select user_id from membership where user_id = $1")
                .bind(u)
                .fetch_optional(&mut *tx)
                .await?
        }
        None => None,
    };
    if already.is_some() {
        return Err(ApiError::Conflict(
            "Email ini sudah menjadi anggota toko".into(),
        ));
    }

    // Any still-open invite for the same address is replaced, so the owner
    // cannot leave two live codes.
    sqlx::query(
        "update membership_invite set expires_at = now()
         where email = $1::citext and accepted_at is null",
    )
    .bind(&email)
    .execute(&mut *tx)
    .await?;

    let code = new_code();
    let id = now_v7();
    let expires_at = Utc::now() + Duration::days(INVITE_DAYS);
    sqlx::query(
        "insert into membership_invite
           (id, tenant_id, email, role, token_hash, invited_by, expires_at)
         values ($1, current_setting('app.tenant_id')::uuid, $2::citext, 'staff', $3, $4, $5)",
    )
    .bind(id)
    .bind(&email)
    .bind(code_hash(&code))
    .bind(ctx.user_id)
    .bind(expires_at)
    .execute(&mut *tx)
    .await?;

    let tenant_name: String = sqlx::query_scalar("select name from tenant where id = $1")
        .bind(ctx.tenant_id)
        .fetch_one(&mut *tx)
        .await?;
    tx.commit().await?;

    Ok(Json(json!({
        "id": id,
        "email": email,
        "role": "staff",
        "code": code,
        "expires_at": expires_at,
        "shop": tenant_name,
        "note": "Bagikan kode ini ke staf. Kode hanya tampil sekali dan berlaku 7 hari.",
    })))
}

/// GET /v1/members/invites — still-open invites.
pub async fn list_invites(State(st): State<AppState>, ctx: AuthCtx) -> ApiResult<Json<Value>> {
    ctx.require(Cap::MemberManage)?;
    let mut tx = begin_tx(&st.pool, &ctx).await?;
    let rows = sqlx::query(
        "select id, email::text as email, role, expires_at, created_at
         from membership_invite
         where accepted_at is null and expires_at > now()
         order by created_at desc",
    )
    .fetch_all(&mut *tx)
    .await?;
    let mut items = Vec::with_capacity(rows.len());
    for r in &rows {
        items.push(json!({
            "id": r.try_get::<Uuid, _>("id")?,
            "email": r.try_get::<String, _>("email")?,
            "role": r.try_get::<String, _>("role")?,
            "expires_at": r.try_get::<DateTime<Utc>, _>("expires_at")?,
            "created_at": r.try_get::<DateTime<Utc>, _>("created_at")?,
        }));
    }
    tx.commit().await?;
    Ok(Json(json!({ "items": items })))
}

/// DELETE /v1/members/invites/{id}
pub async fn revoke_invite(
    State(st): State<AppState>,
    ctx: AuthCtx,
    Path(id): Path<Uuid>,
) -> ApiResult<Json<Value>> {
    ctx.require(Cap::MemberManage)?;
    let mut tx = begin_tx(&st.pool, &ctx).await?;
    let n = sqlx::query(
        "update membership_invite set expires_at = now()
         where id = $1 and accepted_at is null",
    )
    .bind(id)
    .execute(&mut *tx)
    .await?
    .rows_affected();
    if n == 0 {
        return Err(ApiError::NotFound("Undangan tidak ditemukan".into()));
    }
    tx.commit().await?;
    Ok(Json(json!({ "revoked": true, "id": id })))
}

/// DELETE /v1/members/{user_id} — the owner cannot remove themselves, and a
/// shop always keeps an owner.
pub async fn remove_member(
    State(st): State<AppState>,
    ctx: AuthCtx,
    Path(user_id): Path<Uuid>,
) -> ApiResult<Json<Value>> {
    ctx.require(Cap::MemberManage)?;
    if user_id == ctx.user_id {
        return Err(ApiError::Conflict(
            "Anda tidak bisa menghapus keanggotaan Anda sendiri".into(),
        ));
    }
    let mut tx = begin_tx(&st.pool, &ctx).await?;
    let role: Option<String> = sqlx::query_scalar("select role from membership where user_id = $1")
        .bind(user_id)
        .fetch_optional(&mut *tx)
        .await?;
    let role = role.ok_or_else(|| ApiError::NotFound("Anggota tidak ditemukan".into()))?;
    if role == "owner" {
        let owners: i64 =
            sqlx::query_scalar("select count(*) from membership where role = 'owner'")
                .fetch_one(&mut *tx)
                .await?;
        if owners <= 1 {
            return Err(ApiError::Conflict(
                "Toko harus punya minimal satu pemilik".into(),
            ));
        }
    }
    sqlx::query("delete from membership where user_id = $1")
        .bind(user_id)
        .execute(&mut *tx)
        .await?;
    // history stays: user_app and their rows are untouched
    tx.commit().await?;
    Ok(Json(json!({ "removed": true, "user_id": user_id })))
}

#[derive(Deserialize)]
pub struct AcceptInviteReq {
    pub code: String,
    pub password: String,
    pub name: Option<String>,
}

/// POST /v1/auth/accept-invite — public, like signup.
pub async fn accept_invite(
    State(st): State<AppState>,
    Json(body): Json<AcceptInviteReq>,
) -> ApiResult<Json<Value>> {
    let code = body.code.trim();
    if code.is_empty() {
        return Err(ApiError::validation_field(
            "Kode undangan wajib diisi",
            "code",
            "tidak boleh kosong",
        ));
    }
    if body.password.len() < 8 {
        return Err(ApiError::validation_field(
            "Password minimal 8 karakter",
            "password",
            "min 8",
        ));
    }

    // Definer lookup: no tenant context yet, and expired/used codes vanish.
    let found =
        sqlx::query("select id, tenant_id, email::text as email, role from auth_lookup_invite($1)")
            .bind(code_hash(code))
            .fetch_optional(&st.pool)
            .await?
            .ok_or_else(|| ApiError::Validation {
                message: "Kode undangan tidak valid atau sudah kedaluwarsa".into(),
                fields: None,
            })?;
    let invite_id: Uuid = found.try_get("id")?;
    let tenant_id: Uuid = found.try_get("tenant_id")?;
    let email: String = found.try_get("email")?;
    let role: String = found.try_get("role")?;

    // Existing account: the same email must prove itself with its own password.
    let existing = sqlx::query("select id, password_hash, name from auth_find_user($1)")
        .bind(&email)
        .fetch_optional(&st.pool)
        .await?;

    let (user_id, user_name, new_hash) = match existing {
        Some(row) => {
            let id: Uuid = row.try_get("id")?;
            let password_hash: String = row.try_get("password_hash")?;
            let name: String = row.try_get("name")?;
            if !verify_password(&password_hash, &body.password) {
                return Err(ApiError::Unauthorized(
                    "Password akun ini tidak cocok".into(),
                ));
            }
            (id, name, None)
        }
        None => {
            let id = now_v7();
            let name = body
                .name
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| email.split('@').next().unwrap_or("Staf"))
                .to_string();
            (id, name, Some(hash_password(&body.password)?))
        }
    };

    let mut tx = st.pool.begin().await?;
    set_app_context(&mut tx, Some(tenant_id), Some(user_id)).await?;

    if let Some(hash) = new_hash {
        sqlx::query(
            "insert into user_app (id, email, password_hash, name) values ($1, $2::citext, $3, $4)",
        )
        .bind(user_id)
        .bind(&email)
        .bind(&hash)
        .bind(&user_name)
        .execute(&mut *tx)
        .await?;
    }

    sqlx::query(
        "insert into membership (tenant_id, user_id, role) values ($1, $2, $3)
         on conflict (tenant_id, user_id) do nothing",
    )
    .bind(tenant_id)
    .bind(user_id)
    .bind(&role)
    .execute(&mut *tx)
    .await?;

    sqlx::query("update membership_invite set accepted_at = now() where id = $1")
        .bind(invite_id)
        .execute(&mut *tx)
        .await?;

    let tenant_name: String = sqlx::query_scalar("select name from tenant where id = $1")
        .bind(tenant_id)
        .fetch_one(&mut *tx)
        .await?;
    tx.commit().await?;

    Ok(Json(json!({
        "accepted": true,
        "tenant_id": tenant_id,
        "shop": tenant_name,
        "role": role,
        "email": email,
        "name": user_name,
        "next": "Masuk dengan email dan password Anda",
    })))
}
