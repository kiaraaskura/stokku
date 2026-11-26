//! Bulk item import (T-112) and reconcile (T-126).
//!
//! The import's promise is "a per-row error list, and no half-applied file".
//! These tests pin the two ways that promise breaks: a dry run that writes,
//! and a bad row that takes its neighbours down with it.

mod common;

use axum::extract::{Query, State};
use axum::response::IntoResponse;
use axum::Json;
use rust_decimal::Decimal;
use sqlx::PgPool;
use stokku_api::auth::{signup, SignupReq};
use stokku_api::config::AppConfig;
use stokku_api::ctx::{AuthCtx, Role};
use stokku_api::routes::imports::{import_items, reconcile, ImportQuery, ReconcileQuery};
use stokku_api::routes::items::{list, ItemListQuery};
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

async fn setup(tag: &str) -> (AppState, AuthCtx) {
    let pool = common::fresh_db(tag).await;
    let st = state(pool);
    let Json(tok) = signup(
        State(st.clone()),
        Json(SignupReq {
            email: format!("impor-{tag}-{}@test.local", Uuid::now_v7().simple()),
            password: "SI_SECRET_PASSWORD_KQ4M8W2T".into(),
            name: "Pemilik".into(),
            business_name: format!("Warung Impor {tag}"),
        }),
    )
    .await
    .expect("signup");
    let user_id: Uuid = serde_json::from_value(tok["user"]["id"].clone()).unwrap();
    let tenant_id: Uuid = serde_json::from_value(tok["tenant"]["id"].clone()).unwrap();
    (
        st,
        AuthCtx {
            user_id,
            tenant_id,
            role: Role::Owner,
        },
    )
}

async fn body_of(resp: axum::response::Response) -> serde_json::Value {
    let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX)
        .await
        .unwrap();
    serde_json::from_slice(&bytes).expect("json body")
}

async fn item_count(st: &AppState, ctx: &AuthCtx) -> usize {
    let Json(v) = list(
        State(st.clone()),
        ctx.clone(),
        Query(ItemListQuery {
            q: None,
            category_id: None,
            active: None,
            low_stock: None,
            cursor: None,
        }),
    )
    .await
    .expect("list");
    v["data"].as_array().map(|a| a.len()).unwrap_or(0)
}

const CSV_OK: &str = "name,sku,base_unit,sale_price,cost,min_stock,barcode
Beras Premium,BERAS-1,kg,15000,12000,3,899123
Kopi Sachet,\"KOPI, SACHET\",pcs,2000,1200,10,
";

const CSV_ONE_BAD: &str = "name,sku,base_unit,sale_price
Gula Pasir,GULA-1,kg,12000
Rusak,HARGA-SALAH,kg,dua belas ribu
Kopi,KOPI-1,pcs,2000
";

#[tokio::test]
async fn dry_run_validates_without_writing() {
    if common::admin_url().is_none() {
        eprintln!("SKIPPED: STOKKU_TEST_ADMIN_URL not set");
        return;
    }
    let (st, owner) = setup("impdry").await;
    let before = item_count(&st, &owner).await;

    let resp = import_items(
        State(st.clone()),
        owner.clone(),
        Query(ImportQuery { dry_run: true }),
        CSV_ONE_BAD.to_string(),
    )
    .await
    .expect("dry run")
    .into_response();
    let v = body_of(resp).await;

    assert_eq!(v["dry_run"], true);
    assert_eq!(v["valid"], 2, "two rows are valid");
    assert_eq!(v["failed"], 1, "the bad price is reported");
    assert_eq!(
        v["errors"][0]["row"], 3,
        "row numbers are 1-based incl. header"
    );

    assert_eq!(
        item_count(&st, &owner).await,
        before,
        "a dry run must not create a single item"
    );

    common::drop_db(st.pool.clone()).await;
}

#[tokio::test]
async fn import_keeps_good_rows_and_reports_bad_ones() {
    if common::admin_url().is_none() {
        eprintln!("SKIPPED: STOKKU_TEST_ADMIN_URL not set");
        return;
    }
    let (st, owner) = setup("impgo").await;
    let before = item_count(&st, &owner).await;

    let resp = import_items(
        State(st.clone()),
        owner.clone(),
        Query(ImportQuery { dry_run: false }),
        CSV_ONE_BAD.to_string(),
    )
    .await
    .expect("import")
    .into_response();
    let v = body_of(resp).await;
    assert_eq!(v["valid"], 2);
    assert_eq!(v["failed"], 1);
    assert_eq!(item_count(&st, &owner).await, before + 2);

    // quoted comma: the item name and SKU contain a comma
    let resp = import_items(
        State(st.clone()),
        owner.clone(),
        Query(ImportQuery { dry_run: false }),
        CSV_OK.to_string(),
    )
    .await
    .expect("import quoted")
    .into_response();
    let v = body_of(resp).await;
    assert_eq!(v["valid"], 2, "quoted commas must not split the row: {v}");
    assert_eq!(v["failed"], 0);

    let mut q = std::collections::HashMap::new();
    q.insert("q".to_string(), "Kopi Sachet".to_string());
    let Json(search) =
        stokku_api::routes::items::search(State(st.clone()), owner.clone(), Query(q))
            .await
            .expect("search");
    assert_eq!(search["data"].as_array().unwrap().len(), 1);
    assert_eq!(search["data"][0]["name"], "Kopi Sachet");

    common::drop_db(st.pool.clone()).await;
}

#[tokio::test]
async fn duplicate_sku_inside_one_file_is_refused() {
    if common::admin_url().is_none() {
        eprintln!("SKIPPED: STOKKU_TEST_ADMIN_URL not set");
        return;
    }
    let (st, owner) = setup("impdup").await;
    let csv = "name,sku,base_unit,sale_price
Satu,SAMA,kg,1000
Dua,SAMA,kg,2000
";
    let resp = import_items(
        State(st.clone()),
        owner.clone(),
        Query(ImportQuery { dry_run: false }),
        csv.to_string(),
    )
    .await
    .expect("import")
    .into_response();
    let v = body_of(resp).await;
    assert_eq!(v["valid"], 1);
    assert_eq!(v["failed"], 1, "the second SAMA is refused: {v}");

    let refused = import_items(
        State(st.clone()),
        owner.clone(),
        Query(ImportQuery { dry_run: true }),
        "hanya,kolom,salah\n1,2,3\n".to_string(),
    )
    .await;
    assert!(
        refused.is_err(),
        "a header without name/base_unit/sale_price is refused"
    );

    common::drop_db(st.pool.clone()).await;
}

#[tokio::test]
async fn reconcile_is_ok_on_a_consistent_shop() {
    if common::admin_url().is_none() {
        eprintln!("SKIPPED: STOKKU_TEST_ADMIN_URL not set");
        return;
    }
    let (st, owner) = setup("recon").await;

    let Json(item) = stokku_api::routes::items::create(
        State(st.clone()),
        owner.clone(),
        Json(stokku_api::routes::items::CreateItemReq {
            name: "Gula Rekon".into(),
            sku: Some("REK-1".into()),
            barcodes: None,
            category_id: None,
            base_unit: "kg".into(),
            units: None,
            sale_price: 12000,
            cost: Some(6000),
            min_stock: Some(Decimal::new(5_000, 3)),
            active: None,
            op_id: None,
        }),
    )
    .await
    .expect("item");
    let item_id: Uuid = serde_json::from_value(item["id"].clone()).unwrap();

    let Json(_) = create_move(
        State(st.clone()),
        owner.clone(),
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

    let Json(rep) = reconcile(
        State(st.clone()),
        owner.clone(),
        Query(ReconcileQuery { outlet_id: None }),
    )
    .await
    .expect("reconcile");
    assert_eq!(rep["ok"], true);
    assert_eq!(rep["mismatches"].as_array().unwrap().len(), 0);
    assert!(rep["checked"].as_u64().unwrap() >= 1);

    common::drop_db(st.pool.clone()).await;
}
