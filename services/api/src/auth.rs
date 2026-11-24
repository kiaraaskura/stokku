use std::time::Duration;

use argon2::password_hash::{
    rand_core::OsRng, PasswordHash, PasswordHasher, PasswordVerifier, SaltString,
};
use argon2::Argon2;
use axum::extract::State;
use axum::Json;
use chrono::{DateTime, Utc};
use jsonwebtoken::{encode, EncodingKey, Header};
use rand::RngCore;
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use sqlx::{PgConnection, PgPool, Row};
use uuid::Uuid;

use crate::ctx::{AuthCtx, Role};
use crate::error::{ApiError, ApiResult};
use crate::state::AppState;
use crate::util::{now_v7, set_app_context};

const ACCESS_TTL_SECS: i64 = 15 * 60; // 15 minutes
const REFRESH_TTL_DAYS: i64 = 30; // 30 days

pub fn hash_password(password: &str) -> ApiResult<String> {
    let salt = SaltString::generate(&mut OsRng);
    Argon2::default()
        .hash_password(password.as_bytes(), &salt)
        .map(|h| h.to_string())
        .map_err(|e| ApiError::Internal(format!("hash password gagal: {e}")))
}

pub fn verify_password(hash: &str, password: &str) -> bool {
    let parsed = match PasswordHash::new(hash) {
        Ok(p) => p,
        Err(_) => return false,
    };
    Argon2::default()
        .verify_password(password.as_bytes(), &parsed)
        .is_ok()
}

#[derive(serde::Serialize)]
struct AccessClaimsSer {
    sub: String,
    tenant: String,
    role: String,
    exp: i64,
    iat: i64,
}

fn encode_access(secret: &str, user: Uuid, tenant: Uuid, role: Role) -> ApiResult<String> {
    let now = Utc::now().timestamp();
    let claims = AccessClaimsSer {
        sub: user.to_string(),
        tenant: tenant.to_string(),
        role: role.as_str().to_string(),
        exp: now + ACCESS_TTL_SECS,
        iat: now,
    };
    encode(
        &Header::default(),
        &claims,
        &EncodingKey::from_secret(secret.as_bytes()),
    )
    .map_err(|e| ApiError::Internal(format!("buat token gagal: {e}")))
}

fn gen_refresh_token() -> (String, String) {
    let mut bytes = [0u8; 32];
    OsRng.fill_bytes(&mut bytes);
    let token = hex::encode(bytes);
    let hash = hex::encode(Sha256::digest(token.as_bytes()));
    (token, hash)
}

fn refresh_expiry() -> DateTime<Utc> {
    Utc::now() + Duration::from_secs(REFRESH_TTL_DAYS as u64 * 24 * 3600)
}

async fn insert_refresh_token(
    tx: &mut PgConnection,
    user: Uuid,
    tenant: Uuid,
) -> ApiResult<String> {
    let (token, hash) = gen_refresh_token();
    sqlx::query(
        "insert into refresh_token (id, user_id, tenant_id, token_hash, expires_at)
         values ($1, $2, $3, $4, $5)",
    )
    .bind(now_v7())
    .bind(user)
    .bind(tenant)
    .bind(&hash)
    .bind(refresh_expiry())
    .execute(&mut *tx)
    .await?;
    Ok(token)
}

fn bad_credentials() -> ApiError {
    ApiError::Unauthorized("Email atau password salah".into())
}

#[derive(Deserialize)]
pub struct SignupReq {
    pub email: String,
    pub password: String,
    pub name: String,
    pub business_name: String,
}

/// POST /v1/auth/signup — public; creates tenant + owner membership.
pub async fn signup(
    State(st): State<AppState>,
    Json(body): Json<SignupReq>,
) -> ApiResult<Json<Value>> {
    let email = body.email.trim().to_lowercase();
    if !email.contains('@') || email.len() < 5 {
        return Err(ApiError::validation_field(
            "Email tidak valid",
            "email",
            "harus alamat email",
        ));
    }
    if body.password.len() < 8 {
        return Err(ApiError::validation_field(
            "Password minimal 8 karakter",
            "password",
            "min 8",
        ));
    }
    if body.name.trim().is_empty() {
        return Err(ApiError::validation_field(
            "Nama wajib diisi",
            "name",
            "tidak boleh kosong",
        ));
    }
    if body.business_name.trim().is_empty() {
        return Err(ApiError::validation_field(
            "Nama usaha wajib diisi",
            "business_name",
            "tidak boleh kosong",
        ));
    }

    let user_id = now_v7();
    let tenant_id = now_v7();
    let outlet_id = now_v7();
    let password_hash = hash_password(&body.password)?;

    let mut tx = st.pool.begin().await?;
    set_app_context(&mut tx, Some(tenant_id), Some(user_id)).await?;

    sqlx::query("insert into tenant (id, name) values ($1, $2)")
        .bind(tenant_id)
        .bind(body.business_name.trim())
        .execute(&mut *tx)
        .await?;

    sqlx::query(
        "insert into outlet (id, tenant_id, name, timezone) values ($1, $2, $3, 'Asia/Jakarta')",
    )
    .bind(outlet_id)
    .bind(tenant_id)
    .bind(body.business_name.trim())
    .execute(&mut *tx)
    .await?;

    sqlx::query("insert into user_app (id, email, password_hash, name) values ($1, $2, $3, $4)")
        .bind(user_id)
        .bind(&email)
        .bind(&password_hash)
        .bind(body.name.trim())
        .execute(&mut *tx)
        .await?;

    sqlx::query("insert into membership (tenant_id, user_id, role) values ($1, $2, 'owner')")
        .bind(tenant_id)
        .bind(user_id)
        .execute(&mut *tx)
        .await?;

    // Seeded cash categories (T-130) — opex rules depend on the names
    // 'pembelian_stok' and 'modal' (v_opex, docs/DATA_MODEL.md §6).
    for (name, direction, sort) in [
        ("modal", "in", 0),
        ("penjualan", "in", 1),
        ("pembelian_stok", "out", 0),
        ("listrik", "out", 1),
        ("lain_lain", "out", 9),
    ] {
        sqlx::query(
            "insert into cash_category (id, tenant_id, name, direction, sort, seeded)
             values ($1, $2, $3, $4, $5, true)",
        )
        .bind(now_v7())
        .bind(tenant_id)
        .bind(name)
        .bind(direction)
        .bind(sort)
        .execute(&mut *tx)
        .await?;
    }

    let refresh_token = insert_refresh_token(&mut tx, user_id, tenant_id).await?;
    tx.commit().await?;

    let access_token = encode_access(&st.cfg.jwt_secret, user_id, tenant_id, Role::Owner)?;

    Ok(Json(json!({
        "access_token": access_token,
        "refresh_token": refresh_token,
        "expires_in": ACCESS_TTL_SECS,
        "user": { "id": user_id, "name": body.name.trim(), "email": email },
        "tenant": { "id": tenant_id, "name": body.business_name.trim(), "tax_rate": 0 },
        "outlet": { "id": outlet_id, "name": body.business_name.trim(), "timezone": "Asia/Jakarta" },
        "role": "owner",
    })))
}

#[derive(Deserialize)]
pub struct LoginReq {
    pub email: String,
    pub password: String,
}

struct LoginRow {
    tenant_id: Uuid,
    tenant_name: String,
    outlet_id: Uuid,
    outlet_name: String,
    role: Role,
}

async fn login_rows(pool: &PgPool, user_id: Uuid) -> ApiResult<LoginRow> {
    let mut tx = pool.begin().await?;
    // Only the user context first: membership is user-scoped (RLS), but
    // tenant/outlet stay invisible until the tenant context is set.
    set_app_context(&mut tx, None, Some(user_id)).await?;
    let m: Option<(Uuid, String)> = sqlx::query_as(
        "select tenant_id, role from membership where user_id = $1 order by created_at desc limit 1",
    )
    .bind(user_id)
    .fetch_optional(&mut *tx)
    .await?;
    let Some((tenant_id, role_str)) = m else {
        return Err(ApiError::Unauthorized(
            "Akun ini belum terhubung ke toko apa pun".into(),
        ));
    };
    let role =
        Role::parse(&role_str).ok_or_else(|| ApiError::Unauthorized("Peran tidak valid".into()))?;

    set_app_context(&mut tx, Some(tenant_id), Some(user_id)).await?;
    let (tenant_name, outlet): (String, Option<(Uuid, String)>) = sqlx::query_as(
        "select t.name,
                (select (o.id, o.name) from outlet o where o.tenant_id = t.id order by o.created_at, o.id limit 1) as outlet
         from tenant t where t.id = $1",
    )
    .bind(tenant_id)
    .fetch_one(&mut *tx)
    .await?;
    let Some((outlet_id, outlet_name)) = outlet else {
        return Err(ApiError::NotFound("Outlet tidak ditemukan".into()));
    };
    drop(tx);
    Ok(LoginRow {
        tenant_id,
        tenant_name,
        outlet_id,
        outlet_name,
        role,
    })
}

/// POST /v1/auth/login — public; rate-limited.
pub async fn login(
    State(st): State<AppState>,
    Json(body): Json<LoginReq>,
) -> ApiResult<Json<Value>> {
    let email = body.email.trim().to_lowercase();
    if !st.login_limiter.allow(&email).await {
        return Err(ApiError::RateLimited);
    }

    let row = sqlx::query("select id, password_hash, name from auth_find_user($1)")
        .bind(&email)
        .fetch_optional(&st.pool)
        .await?;
    let row = row.ok_or_else(bad_credentials)?;
    let user_id: Uuid = row.try_get("id")?;
    let password_hash: String = row.try_get("password_hash")?;
    let user_name: String = row.try_get("name")?;

    if !verify_password(&password_hash, &body.password) {
        return Err(bad_credentials());
    }

    let login = login_rows(&st.pool, user_id).await?;

    let mut tx = st.pool.begin().await?;
    set_app_context(&mut tx, Some(login.tenant_id), Some(user_id)).await?;
    let refresh_token = insert_refresh_token(&mut tx, user_id, login.tenant_id).await?;
    tx.commit().await?;

    let access_token = encode_access(&st.cfg.jwt_secret, user_id, login.tenant_id, login.role)?;

    Ok(Json(json!({
        "access_token": access_token,
        "refresh_token": refresh_token,
        "expires_in": ACCESS_TTL_SECS,
        "user": { "id": user_id, "name": user_name, "email": email },
        "tenant": { "id": login.tenant_id, "name": login.tenant_name, "tax_rate": 0 },
        "outlet": { "id": login.outlet_id, "name": login.outlet_name, "timezone": "Asia/Jakarta" },
        "role": login.role.as_str(),
    })))
}

#[derive(Deserialize)]
pub struct RefreshReq {
    pub refresh_token: String,
}

struct RefreshRow {
    id: Uuid,
    user_id: Uuid,
    tenant_id: Uuid,
    expires_at: DateTime<Utc>,
    rotated_at: Option<DateTime<Utc>>,
    revoked_at: Option<DateTime<Utc>>,
}

async fn lookup_refresh(pool: &PgPool, hash: &str) -> ApiResult<Option<RefreshRow>> {
    let row = sqlx::query(
        "select id, user_id, tenant_id, expires_at, rotated_at, revoked_at from auth_lookup_refresh($1)",
    )
    .bind(hash)
    .fetch_optional(pool)
    .await?;
    Ok(row.map(|r| RefreshRow {
        id: r.try_get("id").expect("id"),
        user_id: r.try_get("user_id").expect("user_id"),
        tenant_id: r.try_get("tenant_id").expect("tenant_id"),
        expires_at: r.try_get("expires_at").expect("expires_at"),
        rotated_at: r.try_get("rotated_at").expect("rotated_at"),
        revoked_at: r.try_get("revoked_at").expect("revoked_at"),
    }))
}

/// POST /v1/auth/refresh — public; rotates; reuse ⇒ revoke all.
pub async fn refresh(
    State(st): State<AppState>,
    Json(body): Json<RefreshReq>,
) -> ApiResult<Json<Value>> {
    let hash = hex::encode(Sha256::digest(body.refresh_token.as_bytes()));
    let Some(row) = lookup_refresh(&st.pool, &hash).await? else {
        return Err(ApiError::Unauthorized("Refresh token tidak valid".into()));
    };

    if row.rotated_at.is_some() || row.revoked_at.is_some() {
        // Reuse detected: revoke every active session of this user.
        sqlx::query("select auth_revoke_tokens($1)")
            .bind(row.user_id)
            .execute(&st.pool)
            .await?;
        return Err(ApiError::Unauthorized(
            "Refresh token sudah dipakai; semua sesi untuk user ini dicabut".into(),
        ));
    }

    if row.expires_at < Utc::now() {
        return Err(ApiError::Unauthorized("Refresh token kedaluwarsa".into()));
    }

    let mut tx = st.pool.begin().await?;
    set_app_context(&mut tx, Some(row.tenant_id), Some(row.user_id)).await?;

    sqlx::query("update refresh_token set rotated_at = now() where id = $1 and rotated_at is null")
        .bind(row.id)
        .execute(&mut *tx)
        .await?;
    let new_refresh = insert_refresh_token(&mut tx, row.user_id, row.tenant_id).await?;

    let role_str: Option<String> =
        sqlx::query_scalar("select role from membership where tenant_id = $1 and user_id = $2")
            .bind(row.tenant_id)
            .bind(row.user_id)
            .fetch_optional(&mut *tx)
            .await?;
    let role = Role::parse(role_str.as_deref().unwrap_or("staff"))
        .ok_or_else(|| ApiError::Unauthorized("Peran tidak valid".into()))?;

    let user_name: String = sqlx::query_scalar("select name from user_app where id = $1")
        .bind(row.user_id)
        .fetch_one(&mut *tx)
        .await?;

    tx.commit().await?;

    let access_token = encode_access(&st.cfg.jwt_secret, row.user_id, row.tenant_id, role)?;

    Ok(Json(json!({
        "access_token": access_token,
        "refresh_token": new_refresh,
        "expires_in": ACCESS_TTL_SECS,
        "user": { "id": row.user_id, "name": user_name },
        "tenant": { "id": row.tenant_id },
        "role": role.as_str(),
    })))
}

/// POST /v1/auth/logout — public; revokes the presented refresh token.
pub async fn logout(
    State(st): State<AppState>,
    Json(body): Json<RefreshReq>,
) -> ApiResult<Json<Value>> {
    let hash = hex::encode(Sha256::digest(body.refresh_token.as_bytes()));
    if let Some(row) = lookup_refresh(&st.pool, &hash).await? {
        let mut tx = st.pool.begin().await?;
        set_app_context(&mut tx, Some(row.tenant_id), Some(row.user_id)).await?;
        sqlx::query(
            "update refresh_token set revoked_at = now() where id = $1 and revoked_at is null",
        )
        .bind(row.id)
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
    }
    Ok(Json(json!({ "ok": true })))
}

/// GET /v1/me — user, tenant, outlets, role, capabilities.
pub async fn me(State(st): State<AppState>, ctx: AuthCtx) -> ApiResult<Json<Value>> {
    let mut tx = st.pool.begin().await?;
    set_app_context(&mut tx, Some(ctx.tenant_id), Some(ctx.user_id)).await?;

    let user: Option<(Uuid, String, String)> =
        sqlx::query_as("select id, name, email::text as email from user_app where id = $1")
            .bind(ctx.user_id)
            .fetch_optional(&mut *tx)
            .await?;
    let Some((user_id, user_name, email)) = user else {
        return Err(ApiError::Unauthorized("User tidak ditemukan".into()));
    };

    let tenant: Option<(Uuid, String, i64)> = sqlx::query_as(
        "select id, name, coalesce(tax_rate, 0)::bigint as tax_rate from tenant where id = $1",
    )
    .bind(ctx.tenant_id)
    .fetch_optional(&mut *tx)
    .await?;
    let Some((tenant_id, tenant_name, tax_rate)) = tenant else {
        return Err(ApiError::Unauthorized("Tenant tidak ditemukan".into()));
    };

    let outlets: Vec<(Uuid, String, String)> =
        sqlx::query_as("select id, name, timezone from outlet order by created_at, id")
            .fetch_all(&mut *tx)
            .await?;

    let role_str: Option<String> =
        sqlx::query_scalar("select role from membership where tenant_id = $1 and user_id = $2")
            .bind(ctx.tenant_id)
            .bind(ctx.user_id)
            .fetch_one(&mut *tx)
            .await?;
    let role = Role::parse(role_str.as_deref().unwrap_or("staff")).unwrap_or(Role::Staff);

    tx.commit().await?;

    let outlet = outlets.first();

    Ok(Json(json!({
        "user": { "id": user_id, "name": user_name, "email": email },
        "tenant": { "id": tenant_id, "name": tenant_name, "tax_rate": tax_rate },
        "outlet": outlet.map(|(id, name, tz)| json!({
            "id": id, "name": name, "timezone": tz
        })),
        "outlets": outlets.iter().map(|(id, name, tz)| json!({
            "id": id, "name": name, "timezone": tz
        })).collect::<Vec<_>>(),
        "role": role.as_str(),
        "capabilities": role.capabilities(),
    })))
}
