//! Sync tests (T-302/T-303) per docs/SYNC_INCREMENT.md:
//! - push 3 mixed ops -> applied; identical replay -> all duplicate,
//!   totals unchanged
//! - one invalid op in a batch -> rejected with reason, the others applied
//! - pull returns rows with server_seq; a soft-deleted item pulls as a
//!   tombstone
//! - item.create with op_id replayed via REST -> one row, not two
//! - staff cannot push item.update; a cross-tenant op_id is not visible to
//!   another tenant (duplicate detection is tenant-blind, op results are not)

mod common;

use axum::extract::{Query, State};
use axum::Json;
use rust_decimal::Decimal;
use sqlx::PgPool;
use stokku_api::auth::{signup, SignupReq};
use stokku_api::config::AppConfig;
use stokku_api::ctx::{AuthCtx, Role};
use stokku_api::routes::items::{create as create_item, CreateItemReq};

use stokku_api::routes::sync::{pull, push, PullQuery, PushOp, PushReq};
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

async fn tenant(pool: &PgPool, tag: &str) -> (AppState, AuthCtx, AuthCtx, Uuid) {
    let st = state(pool.clone());
    let email = format!("sync-{tag}-{}@test.local", Uuid::now_v7().simple());
    let Json(tok) = signup(
        State(st.clone()),
        Json(SignupReq {
            email,
            password: "password-uji-12345678".into(),
            name: "Pemilik".into(),
            business_name: format!("Warung Sync {tag}"),
        }),
    )
    .await
    .expect("signup");
    let user_id: Uuid = serde_json::from_value(tok["user"]["id"].clone()).unwrap();
    let tenant_id: Uuid = serde_json::from_value(tok["tenant"]["id"].clone()).unwrap();
    let outlet_id: Uuid = serde_json::from_value(tok["outlet"]["id"].clone()).unwrap();

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
            "sync-staff-{tag}-{}@test.local",
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

    (
        st,
        AuthCtx {
            user_id,
            tenant_id,
            role: Role::Owner,
        },
        AuthCtx {
            user_id: staff_id,
            tenant_id,
            role: Role::Staff,
        },
        outlet_id,
    )
}

fn op(kind: &str, payload: serde_json::Value) -> PushOp {
    PushOp {
        op_id: Uuid::now_v7(),
        kind: kind.into(),
        payload,
        client_ts: Some("2026-11-25T10:00:00Z".into()),
    }
}

#[tokio::test]
async fn push_applies_replays_dedupe_and_rejects_per_op() {
    if common::admin_url().is_none() {
        eprintln!("SKIPPED: STOKKU_TEST_ADMIN_URL not set");
        return;
    }
    let pool = common::fresh_db("sync").await;
    let (st, owner, staff, outlet) = tenant(&pool, "a").await;

    // seed one item + stock through the REST engine
    let Json(item) = create_item(
        State(st.clone()),
        owner.clone(),
        Json(CreateItemReq {
            name: "Gula Sync".into(),
            sku: None,
            barcodes: None,
            category_id: None,
            base_unit: "pcs".into(),
            units: None,
            sale_price: 12000,
            cost: Some(6000),
            min_stock: None,
            active: None,
            op_id: None,
        }),
    )
    .await
    .expect("item");
    let item_id: Uuid = serde_json::from_value(item["id"].clone()).unwrap();
    let Json(_mv) = create_move(
        State(st.clone()),
        owner.clone(),
        Json(StockMoveReq {
            item_id,
            outlet_id: None,
            r#type: "in".into(),
            qty_positive: Decimal::new(20_000, 3),
            unit_cost: Some(6000),
            business_date: None,
            supplier: None,
            note: None,
            op_id: None,
        }),
    )
    .await
    .expect("stock in");

    // ---- batch 1: 3 mixed ops -> applied ----
    let ops = vec![
        op(
            "stock_move.create",
            serde_json::json!({"item_id": item_id, "type": "in",
                               "qty_positive": 10, "unit_cost": 9000}),
        ),
        op(
            "sale.create",
            serde_json::json!({"outlet_id": outlet, "business_date": "2026-11-25",
                               "payment_method": "cash", "paid": true,
                               "lines": [{"item_id": item_id, "qty": 5, "unit_price": 12000}]}),
        ),
        op(
            "cash_entry.create",
            serde_json::json!({"direction": "out", "amount": 5000, "category": "listrik",
                               "business_date": "2026-11-25"}),
        ),
    ];
    let Json(r1) = push(
        State(st.clone()),
        owner.clone(),
        Json(PushReq {
            device_id: Some(Uuid::now_v7()),
            ops,
        }),
    )
    .await
    .expect("push 1");
    let statuses1: Vec<&str> = r1["results"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| r["status"].as_str().unwrap())
        .collect();
    assert_eq!(statuses1, vec!["applied", "applied", "applied"], "{r1:?}");
    let cursor1: i64 = serde_json::from_value(r1["cursor"].clone()).unwrap();
    assert!(cursor1 > 0);

    // snapshot totals
    let rev_before: i64 = report_revenue(&st, &owner).await;
    assert_eq!(rev_before, 60000);

    // ---- replay identical batch -> all duplicate, totals unchanged ----
    // same op_ids as batch 1: op_log.op_id must dedupe them
    let replay = PushReq {
        device_id: Some(Uuid::now_v7()),
        ops: vec![
            PushOp {
                op_id: serde_json::from_value(r1["results"][0]["op_id"].clone()).unwrap(),
                kind: "stock_move.create".into(),
                payload: serde_json::json!({"item_id": item_id, "type": "in",
                                           "qty_positive": 10, "unit_cost": 9000}),
                client_ts: Some("2026-11-25T10:00:00Z".into()),
            },
            PushOp {
                op_id: serde_json::from_value(r1["results"][1]["op_id"].clone()).unwrap(),
                kind: "sale.create".into(),
                payload: serde_json::json!({"outlet_id": outlet, "business_date": "2026-11-25",
                                           "payment_method": "cash", "paid": true,
                                           "lines": [{"item_id": item_id, "qty": 5, "unit_price": 12000}]}),
                client_ts: Some("2026-11-25T10:00:01Z".into()),
            },
            PushOp {
                op_id: serde_json::from_value(r1["results"][2]["op_id"].clone()).unwrap(),
                kind: "cash_entry.create".into(),
                payload: serde_json::json!({"direction": "out", "amount": 5000,
                                           "category": "listrik", "business_date": "2026-11-25"}),
                client_ts: Some("2026-11-25T10:00:02Z".into()),
            },
        ],
    };
    let Json(r2) = push(State(st.clone()), owner.clone(), Json(replay))
        .await
        .expect("replay");
    let statuses2: Vec<&str> = r2["results"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| r["status"].as_str().unwrap())
        .collect();
    assert_eq!(
        statuses2,
        vec!["duplicate", "duplicate", "duplicate"],
        "{r2:?}"
    );
    assert_eq!(
        report_revenue(&st, &owner).await,
        60000,
        "totals unchanged after replay"
    );
    let moves_after: i64 = count_rows(&pool, &owner, "select count(*) from stock_move").await;
    assert_eq!(
        moves_after,
        1 + 1 + 1,
        "no double-apply: initial + batch1 sale + (none extra)"
    );

    // ---- batch with one invalid op: rejected, others applied ----
    let good_cash = op(
        "cash_entry.create",
        serde_json::json!({"direction": "in", "amount": 25000, "category": "modal",
                           "business_date": "2026-11-25"}),
    );
    let bad_stock = op(
        "stock_move.create",
        serde_json::json!({"item_id": item_id, "type": "in", "qty_positive": 0}),
    );
    let good_cash2 = op(
        "cash_entry.create",
        serde_json::json!({"direction": "out", "amount": 1000, "category": "lain_lain",
                           "business_date": "2026-11-25"}),
    );
    let Json(r3) = push(
        State(st.clone()),
        owner.clone(),
        Json(PushReq {
            device_id: None,
            ops: vec![good_cash, bad_stock, good_cash2],
        }),
    )
    .await
    .expect("push 3");
    let r3rows = r3["results"].as_array().unwrap();
    assert_eq!(r3rows[0]["status"], "applied");
    assert_eq!(
        r3rows[1]["status"], "rejected",
        "invalid op must be rejected"
    );
    assert!(r3rows[1]["reason"]
        .as_str()
        .unwrap()
        .contains("Qty harus lebih dari 0"));
    assert_eq!(
        r3rows[2]["status"], "applied",
        "rejection must not abort the batch"
    );
    // revenue unchanged; the bad op left no trace
    assert_eq!(report_revenue(&st, &owner).await, 60000);
    let moves_after3: i64 = count_rows(&pool, &owner, "select count(*) from stock_move").await;
    assert_eq!(moves_after3, moves_after, "rejected op applied nothing");

    // ---- staff cannot push item.update ----
    let staff_op = PushOp {
        op_id: Uuid::now_v7(),
        kind: "item.update".into(),
        payload: serde_json::json!({"item_id": item_id, "sale_price": 999}),
        client_ts: None,
    };
    let Json(r4) = push(
        State(st.clone()),
        staff,
        Json(PushReq {
            device_id: None,
            ops: vec![staff_op],
        }),
    )
    .await
    .expect("push 4");
    assert_eq!(
        r4["results"][0]["status"], "rejected",
        "staff item.update rejected"
    );
    assert!(r4["results"][0]["reason"]
        .as_str()
        .unwrap()
        .contains("Peran Anda"));

    // ---- pull: rows with server_seq ----
    let Json(p1) = pull(
        State(st.clone()),
        owner.clone(),
        Query(PullQuery {
            cursor: Some(0),
            limit: None,
        }),
    )
    .await
    .expect("pull from zero");
    let changes = p1["changes"].as_array().unwrap();
    assert!(!changes.is_empty());
    for c in changes {
        assert!(c["server_seq"].as_i64().unwrap() > 0);
        assert!(c["table"].is_string());
    }
    let total = changes.len() as i64;
    let cur: i64 = serde_json::from_value(p1["cursor"].clone()).unwrap();
    assert!(cur > 0, "cursor is a server_seq watermark");

    // pull with cursor returns only newer rows
    let Json(p2) = pull(
        State(st.clone()),
        owner.clone(),
        Query(PullQuery {
            cursor: Some(cur),
            limit: None,
        }),
    )
    .await
    .expect("pull from cursor");
    assert_eq!(
        p2["changes"].as_array().unwrap().len(),
        0,
        "nothing new yet"
    );
    assert_eq!(total, cur, "cursor counted every change");

    // ---- tombstone: soft-delete an item, pull shows deleted: true ----
    let Json(to_del) = create_item(
        State(st.clone()),
        owner.clone(),
        Json(CreateItemReq {
            name: "Kubus Hancur".into(),
            sku: None,
            barcodes: None,
            category_id: None,
            base_unit: "pcs".into(),
            units: None,
            sale_price: 1000,
            cost: None,
            min_stock: None,
            active: None,
            op_id: None,
        }),
    )
    .await
    .expect("item to delete");
    let del_id: Uuid = serde_json::from_value(to_del["id"].clone()).unwrap();
    let _resp: axum::Json<serde_json::Value> = stokku_api::routes::items::soft_delete(
        State(st.clone()),
        owner.clone(),
        axum::extract::Path(del_id),
    )
    .await
    .expect("soft delete");

    let Json(p3) = pull(
        State(st.clone()),
        owner.clone(),
        Query(PullQuery {
            cursor: Some(cur),
            limit: None,
        }),
    )
    .await
    .expect("pull after delete");
    let tomb = p3["changes"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["table"] == "item" && c["row"]["id"] == serde_json::json!(del_id))
        .expect("deleted item must still pull");
    assert_eq!(tomb["deleted"], serde_json::json!(true), "tombstone flag");

    // ---- cross-tenant: another tenant cannot see tenant A's op or rows ----
    let (_st2, owner2, _staff2, _outlet2) = tenant(&pool, "b").await;
    // tenant A's op_ids must not resolve as duplicates for tenant B:
    // same op_id pushed by B is REJECTED as a different tenant's op is not
    // visible... but op_log.op_id is a GLOBAL primary key, so it IS a
    // duplicate by key. The row must NOT be visible to B though:
    let a_op_id: Uuid = serde_json::from_value(r1["results"][0]["op_id"].clone()).unwrap();
    let cross = PushReq {
        device_id: None,
        ops: vec![PushOp {
            op_id: a_op_id,
            kind: "item.create".into(),
            payload: serde_json::json!({"name": "Stok Orang Lain", "base_unit": "pcs", "sale_price": 1}),
            client_ts: None,
        }],
    };
    let Json(rc) = push(State(st.clone()), owner2.clone(), Json(cross))
        .await
        .expect("cross-tenant push");
    // op_log.op_id is the global exactly-once key: status is duplicate,
    // and critically NO new row was created in tenant B
    assert_eq!(rc["results"][0]["status"], "duplicate");
    let b_items: i64 = count_rows(&pool, &owner2, "select count(*) from item").await;
    assert_eq!(b_items, 0, "cross-tenant op created nothing in tenant B");
    // and B's change_log / pull shows no tenant-A rows
    let tenant_b = owner2.tenant_id;
    let Json(pb) = pull(
        State(st.clone()),
        owner2,
        Query(PullQuery {
            cursor: Some(0),
            limit: None,
        }),
    )
    .await
    .expect("pull B");
    for c in pb["changes"].as_array().unwrap() {
        // every row B can pull is B's own (signup rows) — never tenant A's
        let row = &c["row"];
        let belongs = row["tenant_id"] == serde_json::json!(tenant_b)
            || (c["table"] == "tenant" && row["id"] == serde_json::json!(tenant_b))
            || row["tenant_id"].is_null() && c["table"] == "membership";
        assert!(
            belongs || c["table"] == "membership",
            "cross-tenant leak: {} {:?}",
            c["table"],
            row
        );
    }
    // tenant A's item must be absent from B's pull entirely
    let names: Vec<&str> = pb["changes"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|c| c["table"] == "item")
        .filter_map(|c| c["row"]["name"].as_str())
        .collect();
    assert!(
        !names.contains(&"Gula Sync"),
        "tenant A item leaked into B's pull: {names:?}"
    );

    common::drop_db(pool).await;
}

/// exactly-once on POST /items with op_id, replayed via REST: 1 row not 2.
#[tokio::test]
async fn item_create_with_op_id_replays_once() {
    if common::admin_url().is_none() {
        eprintln!("SKIPPED: STOKKU_TEST_ADMIN_URL not set");
        return;
    }
    let pool = common::fresh_db("sync-items").await;
    let (st, owner, _staff, _outlet) = tenant(&pool, "c").await;

    let op_id = Uuid::now_v7();
    let build = || CreateItemReq {
        name: "Gula Once".into(),
        sku: None,
        barcodes: None,
        category_id: None,
        base_unit: "pcs".into(),
        units: None,
        sale_price: 12000,
        cost: None,
        min_stock: None,
        active: None,
        op_id: Some(op_id),
    };
    let Json(first) = create_item(State(st.clone()), owner.clone(), Json(build()))
        .await
        .expect("first create");
    assert!(first["id"].is_string(), "created: {first:?}");
    let Json(second) = create_item(State(st.clone()), owner.clone(), Json(build()))
        .await
        .expect("replay must 200");
    assert_eq!(
        second["duplicate"],
        serde_json::json!(true),
        "replay dedupes: {second:?}"
    );
    let n: i64 = count_rows(
        &pool,
        &owner,
        "select count(*) from item where name = 'Gula Once'",
    )
    .await;
    assert_eq!(n, 1, "one row, not two");

    common::drop_db(pool).await;
}

async fn report_revenue(st: &AppState, ctx: &AuthCtx) -> i64 {
    let Json(rep) = stokku_api::routes::reports::laba_rugi(
        State(st.clone()),
        ctx.clone(),
        axum::extract::Query(stokku_api::routes::reports::LabaRugiQuery {
            from: Some("2026-11-01".into()),
            to: Some("2026-11-30".into()),
            compare: None,
        }),
    )
    .await
    .expect("laba rugi");
    serde_json::from_value(rep["revenue"].clone()).unwrap()
}

async fn count_rows(pool: &PgPool, ctx: &AuthCtx, sql: &str) -> i64 {
    let mut tx = pool.begin().await.unwrap();
    stokku_api::util::set_app_context(&mut tx, Some(ctx.tenant_id), Some(ctx.user_id))
        .await
        .unwrap();
    let n: i64 = sqlx::query_scalar(sql).fetch_one(&mut *tx).await.unwrap();
    tx.commit().await.unwrap();
    n
}
