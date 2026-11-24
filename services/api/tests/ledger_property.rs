//! Property test for the stock ledger (T-120/T-121/T-122):
//! sum(qty deltas) == stock_level over a few thousand random ops,
//! cost_avg never negative, negative stock allowed.
//!
//! Needs a throwaway Postgres reachable as superuser:
//!   STOKKU_TEST_ADMIN_URL=postgres://user@127.0.0.1:PORT/postgres
//! Skips (with a message) when not set, so plain `cargo test` still passes.

use rust_decimal::Decimal;
use sqlx::PgConnection;
use stokku_api::stock::{avg_after_in, avg_after_removing, post_move, PostMove};
use stokku_api::util::{now_v7, set_app_context};
use uuid::Uuid;

mod common;

struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }
    fn pick<'a>(&mut self, items: &[&'a str]) -> &'a str {
        items[(self.next() % items.len() as u64) as usize]
    }
    fn qty(&mut self) -> Decimal {
        // 0.001 .. 20.000, 3 dp
        let milli = (self.next() % 20_000) + 1;
        Decimal::new(milli as i64, 3)
    }
    fn cost(&mut self) -> i64 {
        (self.next() % 20_000) as i64 + 100
    }
}
/// Pure math: the acceptance spine 10@6.000 + 10@9.000 → 7.500.
#[test]
fn moving_average_acceptance_math() {
    let d = Decimal::new(10_000, 3); // 10.000
    let avg1 = avg_after_in(Decimal::ZERO, 0, d, 6000);
    assert_eq!(avg1, 6000, "first buy sets the cost");
    let avg2 = avg_after_in(d, avg1, d, 9000);
    assert_eq!(avg2, 7500, "moving weighted average, not 9.000");

    // sell 5 (stock 15), then reverse the 10@9.000 purchase:
    // value pool 15×7.500 − 10×9.000 = 22.500 over 5 units → 4.500
    let avg3 = avg_after_removing(Decimal::new(15_000, 3), avg2, d, 9000);
    assert_eq!(avg3, Some(4500));
}
#[tokio::test]
async fn stock_level_projection_matches_sum_of_moves() {
    if common::admin_url().is_none() {
        eprintln!("SKIPPED: STOKKU_TEST_ADMIN_URL not set");
        return;
    }
    let pool = common::fresh_db("prop").await;

    let tenant = now_v7();
    let outlet = now_v7();
    let owner = now_v7();
    let item_a = now_v7();
    let item_b = now_v7();

    let mut tx = pool.begin().await.unwrap();
    set_app_context(&mut tx, Some(tenant), Some(owner))
        .await
        .unwrap();
    sqlx::query("insert into tenant (id, name) values ($1, 'Toko Uji Properti')")
        .bind(tenant)
        .execute(&mut *tx)
        .await
        .unwrap();
    sqlx::query("insert into outlet (id, tenant_id, name) values ($1, $2, 'Outlet Uji')")
        .bind(outlet)
        .bind(tenant)
        .execute(&mut *tx)
        .await
        .unwrap();
    sqlx::query(
        "insert into user_app (id, email, password_hash, name) values ($1, $2, 'x', 'Penguji')",
    )
    .bind(owner)
    .bind(format!("prop-{owner}@test.local"))
    .execute(&mut *tx)
    .await
    .unwrap();
    sqlx::query("insert into membership (tenant_id, user_id, role) values ($1, $2, 'owner')")
        .bind(tenant)
        .bind(owner)
        .execute(&mut *tx)
        .await
        .unwrap();
    for item in [item_a, item_b] {
        sqlx::query(
            "insert into item (id, tenant_id, name, base_unit, sale_price, cost_avg)
             values ($1, $2, 'Item Uji', 'pcs', 10000, 0)",
        )
        .bind(item)
        .bind(tenant)
        .execute(&mut *tx)
        .await
        .unwrap();
    }
    tx.commit().await.unwrap();

    // ---- a few thousand random ops through the real posting engine ----
    const OPS: usize = 2500;
    let mut rng = Rng(0xC0FFEE);
    let kinds = ["in", "in", "in", "sale", "sale", "loss", "adjust", "return"];

    let mut tx = pool.begin().await.unwrap();
    set_app_context(&mut tx, Some(tenant), Some(owner))
        .await
        .unwrap();
    for i in 0..OPS {
        let kind = rng.pick(&kinds);
        let item = if rng.next().is_multiple_of(2) {
            item_a
        } else {
            item_b
        };
        let qty = rng.qty();
        let cost = rng.cost();
        let signed = if kind == "in" || kind == "return" {
            qty
        } else {
            -qty
        };

        let old_qty: Decimal =
            sqlx::query_scalar("select coalesce(sum(qty), 0) from stock_level where item_id = $1")
                .bind(item)
                .fetch_one(&mut *tx)
                .await
                .unwrap();

        let new_avg = if kind == "in" {
            Some(avg_after_in(
                old_qty,
                cur_avg_item(&mut tx, item).await,
                qty,
                cost,
            ))
        } else {
            None
        };
        post_move(
            &mut tx,
            owner,
            &PostMove {
                item_id: item,
                outlet_id: outlet,
                qty: signed,
                unit_cost: cost,
                kind,
                ref_type: None,
                ref_id: None,
                business_date: chrono::NaiveDate::from_ymd_opt(2026, 11, 24).unwrap(),
                note: Some(format!("op {i}")),
                op_id: None,
            },
            new_avg,
        )
        .await
        .unwrap();

        // invariant checked continuously, not only at the end
        if i % 250 == 0 || i == OPS - 1 {
            for it in [item_a, item_b] {
                let sum: Decimal = sqlx::query_scalar(
                    "select coalesce(sum(qty), 0) from stock_move where item_id = $1 and outlet_id = $2",
                )
                .bind(it).bind(outlet).fetch_one(&mut *tx).await.unwrap();
                let level: Decimal = sqlx::query_scalar(
                    "select coalesce((select qty from stock_level where item_id = $1 and outlet_id = $2), 0)",
                )
                .bind(it).bind(outlet).fetch_one(&mut *tx).await.unwrap();
                assert_eq!(sum, level, "sum(deltas) must equal stock_level (op {i})");
            }
        }
    }
    tx.commit().await.unwrap();

    // final full check incl. cost sanity (must run with the RLS context)
    let mut tx = pool.begin().await.unwrap();
    set_app_context(&mut tx, Some(tenant), Some(owner))
        .await
        .unwrap();
    for item in [item_a, item_b] {
        let sum: Decimal =
            sqlx::query_scalar("select coalesce(sum(qty), 0) from stock_move where item_id = $1")
                .bind(item)
                .fetch_one(&mut *tx)
                .await
                .unwrap();
        let level: Decimal = sqlx::query_scalar(
            "select coalesce((select qty from stock_level where item_id = $1), 0)",
        )
        .bind(item)
        .fetch_one(&mut *tx)
        .await
        .unwrap();
        assert_eq!(sum, level);
        let cost: i64 = sqlx::query_scalar("select cost_avg from item where id = $1")
            .bind(item)
            .fetch_one(&mut *tx)
            .await
            .unwrap();
        assert!(cost >= 0);
    }
    tx.commit().await.unwrap();

    // negative stock is allowed (flagged, never blocked): force one
    let mut tx = pool.begin().await.unwrap();
    set_app_context(&mut tx, Some(tenant), Some(owner))
        .await
        .unwrap();
    let cur: Decimal =
        sqlx::query_scalar("select qty from stock_level where item_id = $1 and outlet_id = $2")
            .bind(item_a)
            .bind(outlet)
            .fetch_one(&mut *tx)
            .await
            .unwrap();
    // post_move takes the SIGNED delta (the HTTP layer applies the sign)
    let big_loss = -(cur + Decimal::new(10_000, 3)); // far beyond stock
    post_move(
        &mut tx,
        owner,
        &PostMove {
            item_id: item_a,
            outlet_id: outlet,
            qty: big_loss,
            unit_cost: 0,
            kind: "loss",
            ref_type: None,
            ref_id: None,
            business_date: chrono::NaiveDate::from_ymd_opt(2026, 11, 24).unwrap(),
            note: Some("paksa stok negatif".to_string()),
            op_id: None,
        },
        None,
    )
    .await
    .expect("negative stock must be allowed");
    tx.commit().await.unwrap();
    let mut tx = pool.begin().await.unwrap();
    set_app_context(&mut tx, Some(tenant), Some(owner))
        .await
        .unwrap();
    let level: Decimal =
        sqlx::query_scalar("select qty from stock_level where item_id = $1 and outlet_id = $2")
            .bind(item_a)
            .bind(outlet)
            .fetch_one(&mut *tx)
            .await
            .unwrap();
    assert!(level < Decimal::ZERO, "level {level} should be negative");
    let flagged: i64 =
        sqlx::query_scalar("select count(*) from stock_level where outlet_id = $1 and qty <= 0")
            .bind(outlet)
            .fetch_one(&mut *tx)
            .await
            .unwrap();
    assert!(
        flagged >= 1,
        "negative stock must be flagged by the qty <= 0 index"
    );
    tx.commit().await.unwrap();

    common::drop_db(pool).await;
}
async fn cur_avg_item(tx: &mut PgConnection, item: Uuid) -> i64 {
    sqlx::query_scalar("select cost_avg from item where id = $1")
        .bind(item)
        .fetch_one(tx)
        .await
        .unwrap()
}
