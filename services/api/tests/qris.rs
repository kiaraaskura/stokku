//! QRIS Tier 0 tests (T-150/T-151/T-153, acceptance D19/D20):
//! - valid payload accepted, corrupted CRC rejected with the message
//! - confirm computes gross/MDR/net (60.000 / 420 / 59.580 at 0.7%)
//! - a second confirm for the same sale is 409, never a second paid payment
//! - laba rugi shows gross revenue and the MDR fee separately

mod common;

use axum::extract::{Path, State};
use axum::response::IntoResponse;
use axum::Json;
use rust_decimal::Decimal;
use serde_json::json;
use sqlx::PgPool;
use stokku_api::auth::{signup, SignupReq};
use stokku_api::config::AppConfig;
use stokku_api::ctx::{AuthCtx, Role};
use stokku_api::routes::items::{create as create_item, CreateItemReq};
use stokku_api::routes::qris::{confirm, put_settings, QrisConfirmReq, QrisSettingsReq};
use stokku_api::routes::reports::{laba_rugi, LabaRugiQuery};
use stokku_api::routes::sales::{create as create_sale, SaleLineReq, SaleReq};
use stokku_api::state::AppState;
use stokku_api::stock::{create as create_move, StockMoveReq};
use uuid::Uuid;

fn state(pool: PgPool) -> AppState {
    AppState::new(
        pool,
        AppConfig {
            database_url: String::new(),
            jwt_secret: "test-secret".into(),
            bind_addr: "127.0.0.1:0".into(),
            app_base_url: None,
            build_hash: "test",
        },
    )
}

/// A minimal but structurally valid static QRIS payload body (TLV),
/// CRC appended with DB's own qris_crc16() so there is one CRC impl.
async fn valid_payload(pool: &PgPool) -> String {
    // the same seed fixture body (scripts/seed.sql)
    let body = "00020101021126420014ID.CO.QRIS.WWW01151234567890123450201U5204541153033605802ID5913WARUNG BU SRI6007JAKARTA";
    let crc: String = sqlx::query_scalar("select qris_crc16($1)")
        .bind(format!("{body}6304"))
        .fetch_one(pool)
        .await
        .expect("crc");
    format!("{body}6304{crc}")
}

#[tokio::test]
async fn qris_settings_and_confirm_flow() {
    if common::admin_url().is_none() {
        eprintln!("SKIPPED: STOKKU_TEST_ADMIN_URL not set");
        return;
    }
    let pool = common::fresh_db("qris").await;
    let st = state(pool.clone());

    let email = format!("qris-{}@test.local", Uuid::now_v7().simple());
    let Json(tok) = signup(
        State(st.clone()),
        Json(SignupReq {
            email,
            password: "password-uji-12345678".into(),
            name: "Pemilik".into(),
            business_name: "Warung QRIS Uji".into(),
        }),
    )
    .await
    .expect("signup");
    let user_id: Uuid = serde_json::from_value(tok["user"]["id"].clone()).unwrap();
    let tenant_id: Uuid = serde_json::from_value(tok["tenant"]["id"].clone()).unwrap();
    let outlet_id: Uuid = serde_json::from_value(tok["outlet"]["id"].clone()).unwrap();
    let ctx = AuthCtx {
        user_id,
        tenant_id,
        role: Role::Owner,
    };

    // ---- settings: valid payload accepted ----
    let payload = valid_payload(&pool).await;
    let Json(set) = put_settings(
        State(st.clone()),
        ctx.clone(),
        Path(outlet_id),
        Json(QrisSettingsReq {
            mode: "static_payload".into(),
            image_url: None,
            payload: Some(payload.clone()),
            mdr_pct: Some(Decimal::new(70, 2)), // 0.70
        }),
    )
    .await
    .expect("valid payload must be accepted");
    assert_eq!(set["mode"], "static_payload");
    assert_eq!(set["payload"], json!(payload));

    // ---- corrupted CRC rejected with the readable reason ----
    let mut bad = payload.clone();
    let last = bad.pop().unwrap();
    bad.push(if last == 'F' { '0' } else { 'F' });
    let err = put_settings(
        State(st.clone()),
        ctx.clone(),
        Path(outlet_id),
        Json(QrisSettingsReq {
            mode: "static_payload".into(),
            image_url: None,
            payload: Some(bad),
            mdr_pct: None,
        }),
    )
    .await
    .expect_err("bad CRC must be rejected");
    let resp = err.into_response();
    assert_eq!(resp.status(), 422);

    // ---- malformed TLV rejected ----
    let err = put_settings(
        State(st.clone()),
        ctx.clone(),
        Path(outlet_id),
        Json(QrisSettingsReq {
            mode: "static_payload".into(),
            image_url: None,
            payload: Some("XYZ".into()),
            mdr_pct: None,
        }),
    )
    .await
    .expect_err("malformed TLV must be rejected");
    let resp = err.into_response();
    assert_eq!(resp.status(), 422);

    // staff may not change settings
    let staff = staff_ctx(&pool, tenant_id).await;
    let err = put_settings(
        State(st.clone()),
        staff,
        Path(outlet_id),
        Json(QrisSettingsReq {
            mode: "none".into(),
            image_url: None,
            payload: None,
            mdr_pct: None,
        }),
    )
    .await
    .expect_err("staff must get 403 on QRIS settings");
    let resp = err.into_response();
    assert_eq!(resp.status(), 403);

    // ---- sale, then confirm: 60.000 / 420 / 59.580 ----
    let Json(item) = create_item(
        State(st.clone()),
        ctx.clone(),
        Json(CreateItemReq {
            name: "Gula QRIS".into(),
            sku: None,
            barcodes: None,
            category_id: None,
            base_unit: "pcs".into(),
            units: None,
            sale_price: 12000,
            cost: Some(6000),
            min_stock: None,
            active: None,
        }),
    )
    .await
    .expect("item");
    let item_id: Uuid = serde_json::from_value(item["id"].clone()).unwrap();
    let Json(_mv) = create_move(
        State(st.clone()),
        ctx.clone(),
        Json(StockMoveReq {
            item_id,
            outlet_id: None,
            r#type: "in".into(),
            qty_positive: Decimal::new(10_000, 3),
            unit_cost: Some(6000),
            business_date: None,
            supplier: None,
            note: None,
            op_id: None,
        }),
    )
    .await
    .expect("stock in");
    let Json(sale) = create_sale(
        State(st.clone()),
        ctx.clone(),
        Json(SaleReq {
            outlet_id: Some(outlet_id),
            business_date: Some("2026-11-25".into()),
            customer_id: None,
            discount: None,
            payment_method: "qris".into(),
            paid: Some(false),
            note: None,
            lines: vec![SaleLineReq {
                item_id,
                qty: Decimal::new(5_000, 3),
                unit_price: 12000,
                discount: None,
            }],
            op_id: None,
        }),
    )
    .await
    .expect("qris sale");
    let sale_id: Uuid = serde_json::from_value(sale["id"].clone()).unwrap();

    let Json(conf) = confirm(
        State(st.clone()),
        ctx.clone(),
        Path(sale_id),
        Json(QrisConfirmReq {
            amount_gross: 60000,
            mdr_pct: Some(Decimal::new(70, 2)),
            paid_at: None,
        }),
    )
    .await
    .expect("first confirm");
    let p = &conf["payment"];
    assert_eq!(p["amount_gross"], json!(60000));
    assert_eq!(p["mdr_amount"], json!(420));
    assert_eq!(p["amount_net"], json!(59580));
    assert_eq!(p["status"], "paid");

    // ---- double confirm: 409, never a second paid payment ----
    let err = confirm(
        State(st.clone()),
        ctx.clone(),
        Path(sale_id),
        Json(QrisConfirmReq {
            amount_gross: 60000,
            mdr_pct: Some(Decimal::new(70, 2)),
            paid_at: None,
        }),
    )
    .await
    .expect_err("second confirm must 409");
    let resp = err.into_response();
    assert_eq!(resp.status(), 409);

    let paid_payments: i64 = {
        // forced RLS: the direct check needs the tenant context
        let mut tx = pool.begin().await.unwrap();
        stokku_api::util::set_app_context(&mut tx, Some(ctx.tenant_id), Some(ctx.user_id))
            .await
            .unwrap();
        let n: i64 = sqlx::query_scalar(
            "select count(*) from payment where sale_id = $1 and status = 'paid'",
        )
        .bind(sale_id)
        .fetch_one(&mut *tx)
        .await
        .unwrap();
        tx.commit().await.unwrap();
        n
    };
    assert_eq!(paid_payments, 1, "exactly one paid payment");

    // ---- laba rugi: gross revenue and MDR fee separately ----
    let Json(rep) = laba_rugi(
        State(st.clone()),
        ctx.clone(),
        axum::extract::Query(LabaRugiQuery {
            from: Some("2026-11-01".into()),
            to: Some("2026-11-30".into()),
            compare: None,
        }),
    )
    .await
    .expect("laba rugi");
    assert_eq!(rep["revenue"], json!(60000), "gross revenue, not net");
    assert_eq!(rep["qris_mdr_fee"], json!(420), "MDR fee separate");
    assert_eq!(
        rep["net_profit"],
        json!(30000 - 0),
        "net = 60000 - 30000 hpp - 0 opex"
    );

    common::drop_db(pool).await;
}

async fn staff_ctx(pool: &PgPool, tenant_id: Uuid) -> AuthCtx {
    let staff_id = Uuid::now_v7();
    let mut tx = pool.begin().await.unwrap();
    stokku_api::util::set_app_context(&mut tx, Some(tenant_id), None)
        .await
        .unwrap();
    sqlx::query(
        "insert into user_app (id, email, password_hash, name) values ($1, $2, 'x', 'Staf')",
    )
    .bind(staff_id)
    .bind(format!("qris-staff-{}@test.local", Uuid::now_v7().simple()))
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
    AuthCtx {
        user_id: staff_id,
        tenant_id,
        role: Role::Staff,
    }
}
