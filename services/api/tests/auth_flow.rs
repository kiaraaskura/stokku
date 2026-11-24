//! Auth flow (T-009 / F-01) and capability enforcement (T-141),
//! driven directly against a throwaway migrated database.
//! Same env requirement as ledger_property.rs:
//!   STOKKU_TEST_ADMIN_URL=postgres://user@127.0.0.1:PORT/postgres

use axum::extract::State;
use axum::response::IntoResponse;
use axum::Json;
use stokku_api::auth::{login, refresh, signup, LoginReq, RefreshReq, SignupReq};
use stokku_api::config::AppConfig;
use stokku_api::ctx::{AuthCtx, Role};
use stokku_api::routes::reports::{laba_rugi, LabaRugiQuery};
use stokku_api::state::AppState;
use uuid::Uuid;

mod common;

fn test_state(pool: sqlx::PgPool) -> AppState {
    AppState::new(
        pool,
        AppConfig {
            database_url: String::new(),
            jwt_secret: "test-secret-for-auth-flow".into(),
            bind_addr: "127.0.0.1:0".into(),
            app_base_url: None,
            build_hash: "test",
        },
    )
}

#[tokio::test]
async fn signup_login_refresh_rotation_reuse_and_capabilities() {
    if common::admin_url().is_none() {
        eprintln!("SKIPPED: STOKKU_TEST_ADMIN_URL not set");
        return;
    }
    let pool = common::fresh_db("auth").await;
    let state = test_state(pool.clone());
    let email = format!("owner-{}@test.local", Uuid::now_v7().simple());

    // signup
    let Json(v) = signup(
        State(state.clone()),
        Json(SignupReq {
            email: email.clone(),
            password: "password-uji-12345678".into(),
            name: "Bu Sri".into(),
            business_name: "Warung Uji".into(),
        }),
    )
    .await
    .expect("signup ok");
    assert_eq!(v["role"], "owner");
    assert!(v["refresh_token"].as_str().unwrap().len() > 30);
    let owner_id: Uuid = serde_json::from_value(v["user"]["id"].clone()).unwrap();
    let tenant_id: Uuid = serde_json::from_value(v["tenant"]["id"].clone()).unwrap();
    let refresh1: String = serde_json::from_value(v["refresh_token"].clone()).unwrap();

    // login
    let Json(lv) = login(
        State(state.clone()),
        Json(LoginReq {
            email: email.clone(),
            password: "password-uji-12345678".into(),
        }),
    )
    .await
    .expect("login ok");
    assert_eq!(lv["user"]["email"], email);
    let refresh2: String = serde_json::from_value(lv["refresh_token"].clone()).unwrap();
    assert_ne!(refresh1, refresh2);

    // wrong password
    let err = login(
        State(state.clone()),
        Json(LoginReq {
            email: email.clone(),
            password: "salah".into(),
        }),
    )
    .await
    .expect_err("wrong password must fail");
    let resp = err.into_response();
    assert_eq!(resp.status(), 401);

    // refresh rotation
    let Json(rv) = refresh(
        State(state.clone()),
        Json(RefreshReq {
            refresh_token: refresh2.clone(),
        }),
    )
    .await
    .expect("refresh ok");
    let refresh3: String = serde_json::from_value(rv["refresh_token"].clone()).unwrap();
    assert_ne!(refresh2, refresh3);

    // REUSE of the rotated refresh2 ⇒ revoke all
    let err = refresh(
        State(state.clone()),
        Json(RefreshReq {
            refresh_token: refresh2,
        }),
    )
    .await
    .expect_err("reuse must fail");
    let resp = err.into_response();
    assert_eq!(resp.status(), 401);

    // ...and the family is dead: the newest token is revoked too
    let err = refresh(
        State(state.clone()),
        Json(RefreshReq {
            refresh_token: refresh3,
        }),
    )
    .await
    .expect_err("revoked token must fail");
    let resp = err.into_response();
    assert_eq!(resp.status(), 401);

    // ---- staff capabilities: 403 on the report, no cost caps ----
    let staff_id = Uuid::now_v7();
    let mut tx = pool.begin().await.unwrap();
    stokku_api::util::set_app_context(&mut tx, Some(tenant_id), Some(owner_id))
        .await
        .unwrap();
    sqlx::query(
        "insert into user_app (id, email, password_hash, name) values ($1, $2, 'x', 'Staf Uji')",
    )
    .bind(staff_id)
    .bind(format!("staff-{}@test.local", Uuid::now_v7().simple()))
    .execute(&mut *tx)
    .await
    .unwrap();
    sqlx::query("insert into membership (tenant_id, user_id, role) values ($1, $2, 'staff')")
        .bind(tenant_id)
        .bind(staff_id)
        .execute(&mut *tx)
        .await
        .unwrap();
    tx.commit().await.unwrap();

    let staff_ctx = AuthCtx {
        user_id: staff_id,
        tenant_id,
        role: Role::Staff,
    };
    assert!(Role::Staff.capabilities().iter().all(|c| !matches!(
        *c,
        "cost.read" | "report.read" | "item.write" | "member.manage" | "export"
    )));

    let err = laba_rugi(
        State(state.clone()),
        staff_ctx.clone(),
        axum::extract::Query(LabaRugiQuery {
            from: None,
            to: None,
            compare: None,
        }),
    )
    .await
    .expect_err("staff must get 403 on laba rugi");
    let resp = err.into_response();
    assert_eq!(resp.status(), 403);

    // owner succeeds (empty month: zeros)
    let owner_ctx = AuthCtx {
        user_id: owner_id,
        tenant_id,
        role: Role::Owner,
    };
    let Json(rep) = laba_rugi(
        State(state),
        owner_ctx,
        axum::extract::Query(LabaRugiQuery {
            from: None,
            to: None,
            compare: Some(true),
        }),
    )
    .await
    .expect("owner can read laba rugi");
    assert_eq!(rep["revenue"], 0);
    assert!(rep["comparison"].is_object());

    common::drop_db(pool).await;
}
