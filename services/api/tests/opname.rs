//! Opname tests (T-124, acceptance B11):
//! - one variance → exactly one adjust move, stock corrected
//! - ATOMICITY: a mid-transaction failure (period lock raising inside the
//!   posting transaction) leaves ZERO adjustments, the session still open
//!   and stock untouched — then retry succeeds
//! - lines immutable after post (history kept)

mod common;

use axum::extract::{Path, State};
use axum::Json;
use rust_decimal::Decimal;
use sqlx::PgPool;
use stokku_api::auth::{signup, SignupReq};
use stokku_api::config::AppConfig;
use stokku_api::ctx::{AuthCtx, Role};
use stokku_api::routes::items::{create as create_item, CreateItemReq};
use stokku_api::routes::opname::{
    create as create_session, get_one, patch_lines, post as post_session, CreateOpnameReq,
    PatchLine, PatchLinesReq,
};
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

struct Setup {
    st: AppState,
    owner: AuthCtx,
    staff: AuthCtx,
    outlet_id: Uuid,
    items: Vec<Uuid>,
    pool: PgPool,
}

async fn setup(tag: &str) -> Setup {
    let pool = common::fresh_db(tag).await;
    let st = state(pool.clone());

    let email = format!("opname-{}@test.local", Uuid::now_v7().simple());
    let Json(tok) = signup(
        State(st.clone()),
        Json(SignupReq {
            email,
            password: "password-uji-12345678".into(),
            name: "Pemilik".into(),
            business_name: "Warung Opname".into(),
        }),
    )
    .await
    .expect("signup");
    let user_id: Uuid = serde_json::from_value(tok["user"]["id"].clone()).unwrap();
    let tenant_id: Uuid = serde_json::from_value(tok["tenant"]["id"].clone()).unwrap();
    let outlet_id: Uuid = serde_json::from_value(tok["outlet"]["id"].clone()).unwrap();

    // a staff member (allowed to run opname: stock.write)
    let staff_id = Uuid::now_v7();
    {
        let mut tx = pool.begin().await.unwrap();
        stokku_api::util::set_app_context(&mut tx, Some(tenant_id), Some(user_id))
            .await
            .unwrap();
        sqlx::query(
            "insert into user_app (id, email, password_hash, name) values ($1, $2, 'x', 'Staf')",
        )
        .bind(staff_id)
        .bind(format!(
            "opname-staff-{}@test.local",
            Uuid::now_v7().simple()
        ))
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
    }

    let owner = AuthCtx {
        user_id,
        tenant_id,
        role: Role::Owner,
    };
    let staff = AuthCtx {
        user_id: staff_id,
        tenant_id,
        role: Role::Staff,
    };

    let mut items = Vec::new();
    for name in ["Kopi Hitam", "Teh Celup"] {
        let Json(item) = create_item(
            State(st.clone()),
            owner.clone(),
            Json(CreateItemReq {
                name: name.into(),
                sku: None,
                barcodes: None,
                category_id: None,
                base_unit: "pcs".into(),
                units: None,
                sale_price: 5000,
                cost: Some(3000),
                min_stock: None,
                active: None,
            }),
        )
        .await
        .expect("item");
        let id: Uuid = serde_json::from_value(item["id"].clone()).unwrap();
        items.push(id);
    }
    for id in &items {
        let Json(_mv) = create_move(
            State(st.clone()),
            owner.clone(),
            Json(StockMoveReq {
                item_id: *id,
                outlet_id: None,
                r#type: "in".into(),
                qty_positive: Decimal::new(15_000, 3),
                unit_cost: Some(3000),
                business_date: None,
                supplier: None,
                note: None,
                op_id: None,
            }),
        )
        .await
        .expect("stock in");
    }

    Setup {
        st,
        owner,
        staff,
        outlet_id,
        items,
        pool,
    }
}

async fn stock_of(pool: &PgPool, s: &Setup, item: Uuid) -> Decimal {
    let mut tx = pool.begin().await.unwrap();
    stokku_api::util::set_app_context(&mut tx, Some(s.owner.tenant_id), Some(s.owner.user_id))
        .await
        .unwrap();
    let q: Decimal = sqlx::query_scalar(
        "select coalesce((select qty from stock_level where item_id = $1 and outlet_id = $2), 0)",
    )
    .bind(item)
    .bind(s.outlet_id)
    .fetch_one(&mut *tx)
    .await
    .unwrap();
    tx.commit().await.unwrap();
    q
}

#[tokio::test]
async fn opname_posts_one_adjust_per_variance() {
    if common::admin_url().is_none() {
        eprintln!("SKIPPED: STOKKU_TEST_ADMIN_URL not set");
        return;
    }
    let s = setup("opname-ok").await;

    let Json(sess) = create_session(
        State(s.st.clone()),
        s.owner.clone(),
        Json(CreateOpnameReq {
            outlet_id: Some(s.outlet_id),
            category_id: None,
            item_ids: Some(s.items.clone()),
            business_date: Some("2026-11-25".into()),
        }),
    )
    .await
    .expect("create session");
    assert_eq!(sess["status"], "open");
    assert_eq!(sess["lines"].as_array().unwrap().len(), 2);
    assert_eq!(sess["lines"][0]["system_qty"], serde_json::json!(15));
    let session_id: Uuid = serde_json::from_value(sess["id"].clone()).unwrap();

    // count 14 on item A (variance −1), 15 on item B (no variance)
    let Json(patched) = patch_lines(
        State(s.st.clone()),
        s.owner.clone(),
        Path(session_id),
        Json(PatchLinesReq {
            lines: vec![
                PatchLine {
                    item_id: s.items[0],
                    counted_qty: Some(Decimal::new(14_000, 3)),
                },
                PatchLine {
                    item_id: s.items[1],
                    counted_qty: Some(Decimal::new(15_000, 3)),
                },
            ],
        }),
    )
    .await
    .expect("patch lines");
    assert_eq!(patched["lines"][0]["counted_qty"], serde_json::json!(14));

    let Json(posted) = post_session(State(s.st.clone()), s.owner.clone(), Path(session_id))
        .await
        .expect("post");
    assert_eq!(posted["posted"], serde_json::json!(true));
    let adj = posted["adjustments"].as_array().unwrap();
    assert_eq!(adj.len(), 1, "exactly one non-zero variance");
    assert_eq!(adj[0]["qty"], serde_json::json!(-1));

    // stock corrected
    let q = stock_of(&s.pool, &s, s.items[0]).await;
    assert_eq!(q, Decimal::new(14_000, 3));

    // re-post is refused
    let err = post_session(State(s.st.clone()), s.owner.clone(), Path(session_id))
        .await
        .expect_err("re-post must 409");
    let resp = axum::response::IntoResponse::into_response(err);
    assert_eq!(resp.status(), 409);

    // history kept: the session still shows the original counts
    let Json(hist) = get_one(State(s.st.clone()), s.owner.clone(), Path(session_id))
        .await
        .expect("history");
    assert_eq!(hist["status"], "posted");
    assert_eq!(hist["lines"][0]["counted_qty"], serde_json::json!(14));

    // counted lines immutable after post (DB guard)
    let err = patch_lines(
        State(s.st.clone()),
        s.owner.clone(),
        Path(session_id),
        Json(PatchLinesReq {
            lines: vec![PatchLine {
                item_id: s.items[0],
                counted_qty: Some(Decimal::new(13_000, 3)),
            }],
        }),
    )
    .await
    .expect_err("posted session lines are frozen (handler)");
    let resp = axum::response::IntoResponse::into_response(err);
    assert_eq!(resp.status(), 409);

    common::drop_db(s.pool).await;
}

#[tokio::test]
async fn opname_failure_is_atomic_zero_adjustments() {
    if common::admin_url().is_none() {
        eprintln!("SKIPPED: STOKKU_TEST_ADMIN_URL not set");
        return;
    }
    let s = setup("opname-atomic").await;

    // session with two variances, dated in a month the owner locks
    let Json(sess) = create_session(
        State(s.st.clone()),
        s.owner.clone(),
        Json(CreateOpnameReq {
            outlet_id: Some(s.outlet_id),
            category_id: None,
            item_ids: Some(s.items.clone()),
            business_date: Some("2026-11-25".into()),
        }),
    )
    .await
    .expect("create session");
    let session_id: Uuid = serde_json::from_value(sess["id"].clone()).unwrap();

    let Json(_) = patch_lines(
        State(s.st.clone()),
        s.owner.clone(),
        Path(session_id),
        Json(PatchLinesReq {
            lines: vec![
                PatchLine {
                    item_id: s.items[0],
                    counted_qty: Some(Decimal::new(12_000, 3)),
                },
                PatchLine {
                    item_id: s.items[1],
                    counted_qty: Some(Decimal::new(10_000, 3)),
                },
            ],
        }),
    )
    .await
    .expect("patch lines");

    // owner locks the period; the stock_move insert inside the posting
    // transaction will then raise for the non-owner actor
    {
        let mut tx = s.pool.begin().await.unwrap();
        stokku_api::util::set_app_context(&mut tx, Some(s.owner.tenant_id), Some(s.owner.user_id))
            .await
            .unwrap();
        sqlx::query(
            "insert into period_lock (tenant_id, outlet_id, period)
             values ($1, $2, date '2026-11-01')",
        )
        .bind(s.owner.tenant_id)
        .bind(s.outlet_id)
        .execute(&mut *tx)
        .await
        .unwrap();
        tx.commit().await.unwrap();
    }

    // staff posts: the FIRST adjust insert raises period_locked → the whole
    // transaction rolls back (423 to the caller)
    let err = post_session(State(s.st.clone()), s.staff.clone(), Path(session_id))
        .await
        .expect_err("locked period must abort the posting");
    let resp = axum::response::IntoResponse::into_response(err);
    assert_eq!(resp.status(), 423);

    // ALL-OR-NOTHING: zero adjustments, session still open, stock untouched
    {
        let mut tx = s.pool.begin().await.unwrap();
        stokku_api::util::set_app_context(&mut tx, Some(s.owner.tenant_id), Some(s.owner.user_id))
            .await
            .unwrap();
        let moves: i64 = sqlx::query_scalar(
            "select count(*) from stock_move where ref_type = 'opname' and ref_id = $1",
        )
        .bind(session_id)
        .fetch_one(&mut *tx)
        .await
        .unwrap();
        assert_eq!(moves, 0, "zero adjustments posted after failure");
        let status: String = sqlx::query_scalar("select status from opname_session where id = $1")
            .bind(session_id)
            .fetch_one(&mut *tx)
            .await
            .unwrap();
        assert_eq!(status, "open", "session must stay open for retry");
        tx.commit().await.unwrap();
    }
    for item in &s.items {
        let q = stock_of(&s.pool, &s, *item).await;
        assert_eq!(q, Decimal::new(15_000, 3), "stock untouched by failed post");
    }

    // retry works: the owner is allowed into the locked period
    let Json(posted) = post_session(State(s.st.clone()), s.owner.clone(), Path(session_id))
        .await
        .expect("owner retry posts");
    assert_eq!(posted["posted"], serde_json::json!(true));
    assert_eq!(posted["adjustments"].as_array().unwrap().len(), 2);
    let q0 = stock_of(&s.pool, &s, s.items[0]).await;
    let q1 = stock_of(&s.pool, &s, s.items[1]).await;
    assert_eq!(q0, Decimal::new(12_000, 3));
    assert_eq!(q1, Decimal::new(10_000, 3));

    common::drop_db(s.pool).await;
}

#[tokio::test]
async fn stock_report_matches_ledger() {
    if common::admin_url().is_none() {
        eprintln!("SKIPPED: STOKKU_TEST_ADMIN_URL not set");
        return;
    }
    let s = setup("report-stock").await;

    use stokku_api::routes::reports::{stock_report, StockReportQuery};
    let Json(rep) = stock_report(
        State(s.st.clone()),
        s.owner.clone(),
        axum::extract::Query(StockReportQuery {
            outlet_id: Some(s.outlet_id),
        }),
    )
    .await
    .expect("stock report");
    assert_eq!(rep["data"].as_array().unwrap().len(), 2);
    // at_cost = sum(qty * cost_avg) = 15*3000 + 15*3000 = 90.000
    assert_eq!(rep["at_cost"], serde_json::json!(90000));
    assert_eq!(rep["at_sale"], serde_json::json!(150000));
    assert_eq!(rep["low_stock_count"], serde_json::json!(0));
    // these items moved TODAY (stock-in dated today), so not dead;
    // dead = no movement in the last 60 days by business_date
    assert_eq!(rep["dead_stock_count"], serde_json::json!(0));

    // staff is refused
    let err = stock_report(
        State(s.st.clone()),
        s.staff.clone(),
        axum::extract::Query(StockReportQuery { outlet_id: None }),
    )
    .await
    .expect_err("staff must get 403");
    let resp = axum::response::IntoResponse::into_response(err);
    assert_eq!(resp.status(), 403);

    common::drop_db(s.pool).await;
}
