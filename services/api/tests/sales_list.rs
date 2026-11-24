//! Regression test for the GET /v1/sales 500 (F-13 in QA-LOG):
//! routes/sales.rs list() selected `sale.note` before the column existed.
//! Posts a real sale, then calls the list handler and asserts exactly one
//! row with the right total and the stored note.
//! Fails on pre-fix code (the list call returns 500/internal).

mod common;

use axum::extract::{Query, State};
use axum::Json;
use stokku_api::auth::signup;
use stokku_api::auth::SignupReq;
use stokku_api::config::AppConfig;
use stokku_api::ctx::{AuthCtx, Role};
use stokku_api::routes::items::{create as create_item, CreateItemReq};
use stokku_api::routes::sales::{
    create as create_sale, list as list_sales, SaleLineReq, SaleListQuery, SaleReq,
};
use stokku_api::state::AppState;
use stokku_api::stock::{create as create_move, StockMoveReq};
use uuid::Uuid;

fn state(pool: sqlx::PgPool) -> AppState {
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

#[tokio::test]
async fn sales_list_returns_one_row_with_total_and_note() {
    if common::admin_url().is_none() {
        eprintln!("SKIPPED: STOKKU_TEST_ADMIN_URL not set");
        return;
    }
    let pool = common::fresh_db("saleslist").await;
    let st = state(pool.clone());

    let email = format!("saleslist-{}@test.local", Uuid::now_v7().simple());
    let Json(tok) = signup(
        State(st.clone()),
        Json(SignupReq {
            email,
            password: "password-uji-12345678".into(),
            name: "Pemilik".into(),
            business_name: "Warung List Uji".into(),
        }),
    )
    .await
    .expect("signup");
    let user_id: Uuid = serde_json::from_value(tok["user"]["id"].clone()).unwrap();
    let tenant_id: Uuid = serde_json::from_value(tok["tenant"]["id"].clone()).unwrap();
    let ctx = AuthCtx {
        user_id,
        tenant_id,
        role: Role::Owner,
    };

    // one item
    let Json(item) = create_item(
        State(st.clone()),
        ctx.clone(),
        Json(CreateItemReq {
            name: "Gula 1 kg".into(),
            sku: None,
            barcodes: None,
            category_id: None,
            base_unit: "pcs".into(),
            units: None,
            sale_price: 12000,
            cost: Some(0),
            min_stock: None,
            active: None,
        }),
    )
    .await
    .expect("create item");
    let item_id: Uuid = serde_json::from_value(item["id"].clone()).unwrap();

    // one stock-in 10 @ 6.000
    let Json(_mv) = create_move(
        State(st.clone()),
        ctx.clone(),
        Json(StockMoveReq {
            item_id,
            outlet_id: None,
            r#type: "in".into(),
            qty_positive: rust_decimal::Decimal::new(10_000, 3),
            unit_cost: Some(6000),
            business_date: Some("2026-11-24".into()),
            supplier: None,
            note: None,
            op_id: None,
        }),
    )
    .await
    .expect("stock in");

    // one sale carrying a note
    let sale_note = "pelanggan langganan, kirim sore";
    let Json(sale) = create_sale(
        State(st.clone()),
        ctx.clone(),
        Json(SaleReq {
            outlet_id: None,
            business_date: Some("2026-11-24".into()),
            customer_id: None,
            discount: None,
            payment_method: "cash".into(),
            paid: Some(true),
            note: Some(sale_note.into()),
            lines: vec![SaleLineReq {
                item_id,
                qty: rust_decimal::Decimal::new(5_000, 3),
                unit_price: 12000,
                discount: None,
            }],
            op_id: None,
        }),
    )
    .await
    .expect("create sale");
    let sale_id: Uuid = serde_json::from_value(sale["id"].clone()).unwrap();

    // THE regression: list must not 500 and must return the row
    let Json(listed) = list_sales(
        State(st.clone()),
        ctx.clone(),
        Query(SaleListQuery {
            from: Some("2026-11-01".into()),
            to: Some("2026-11-30".into()),
            cursor: None,
        }),
    )
    .await
    .expect("GET /v1/sales must not error (pre-fix: sale.note 42703 -> 500)");

    let rows = listed["data"].as_array().expect("data array");
    assert_eq!(rows.len(), 1, "exactly one sale row, got {rows:?}");
    let row = &rows[0];
    assert_eq!(row["id"], serde_json::json!(sale_id));
    assert_eq!(row["total"], serde_json::json!(60000));
    assert_eq!(
        row["note"],
        serde_json::json!(sale_note),
        "note must be stored on the sale row"
    );

    // detail view agrees
    let Json(detail) = stokku_api::routes::sales::get_one(
        State(st.clone()),
        ctx.clone(),
        axum::extract::Path(sale_id),
    )
    .await
    .expect("GET /v1/sales/{id}");
    assert_eq!(detail["note"], serde_json::json!(sale_note));
    assert_eq!(detail["total"], serde_json::json!(60000));

    common::drop_db(pool).await;
}
