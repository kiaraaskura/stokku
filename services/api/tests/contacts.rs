//! Contacts, payables and receivables (T-133).
//!
//! What is worth proving here:
//! - a contact that is already on a transaction cannot be deleted;
//! - a partial payment reduces the outstanding by exactly the amount paid;
//! - an overpayment is refused, not silently clamped;
//! - every payment lands in `cash_entry`, so the money and the bill cannot
//!   drift apart, and a payable payment is not counted as a second expense.

mod common;

use axum::extract::{Path, Query, State};
use axum::Json;
use rust_decimal::Decimal;
use sqlx::{PgPool, Row};
use stokku_api::auth::{signup, SignupReq};
use stokku_api::config::AppConfig;
use stokku_api::ctx::{AuthCtx, Role};
use stokku_api::routes::contacts::{
    create, create_payable, create_receivable, list, list_payables, list_receivables, pay_payable,
    pay_receivable, BillListQuery, BillReq, ContactListQuery, ContactPatch, ContactReq, PaymentReq,
};
use stokku_api::routes::reports::laba_rugi;
use stokku_api::state::AppState;
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

async fn setup(tag: &str) -> (AppState, AuthCtx, AuthCtx) {
    let pool = common::fresh_db(tag).await;
    let st = state(pool.clone());

    let Json(tok) = signup(
        State(st.clone()),
        Json(SignupReq {
            email: format!("kontak-{tag}-{}@test.local", Uuid::now_v7().simple()),
            password: "SI_SECRET_PASSWORD_HQ7T2W9K".into(),
            name: "Pemilik".into(),
            business_name: format!("Warung Kontak {tag}"),
        }),
    )
    .await
    .expect("signup");
    let user_id: Uuid = serde_json::from_value(tok["user"]["id"].clone()).unwrap();
    let tenant_id: Uuid = serde_json::from_value(tok["tenant"]["id"].clone()).unwrap();

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
            "kontak-staff-{tag}-{}@test.local",
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
    )
}

async fn new_contact(st: &AppState, ctx: &AuthCtx, kind: &str, name: &str) -> Uuid {
    let Json(v) = create(
        State(st.clone()),
        ctx.clone(),
        Json(ContactReq {
            kind: kind.into(),
            name: name.into(),
            phone: Some("0812-0000-0000".into()),
        }),
    )
    .await
    .expect("contact");
    serde_json::from_value(v["id"].clone()).unwrap()
}

#[tokio::test]
async fn contacts_crud_and_the_delete_guard() {
    if common::admin_url().is_none() {
        eprintln!("SKIPPED: STOKKU_TEST_ADMIN_URL not set");
        return;
    }
    let (st, owner, staff) = setup("contactscrud").await;

    let supplier = new_contact(&st, &owner, "supplier", "Toko Sumber").await;
    let customer = new_contact(&st, &owner, "customer", "Ibu Wati").await;

    // staff may work with contacts: they are operational, not financial
    let Json(staff_made) = create(
        State(st.clone()),
        staff.clone(),
        Json(ContactReq {
            kind: "customer".into(),
            name: "Pak Budi".into(),
            phone: None,
        }),
    )
    .await
    .expect("staff contact");
    assert_eq!(staff_made["name"], "Pak Budi");

    // filter by type
    let Json(listed) = list(
        State(st.clone()),
        owner.clone(),
        Query(ContactListQuery {
            kind: Some("supplier".into()),
            q: None,
        }),
    )
    .await
    .expect("list");
    let items = listed["items"].as_array().unwrap();
    assert_eq!(items.len(), 1, "only the supplier");
    assert_eq!(items[0]["id"], supplier.to_string());

    // search by name
    let Json(searched) = list(
        State(st.clone()),
        owner.clone(),
        Query(ContactListQuery {
            kind: None,
            q: Some("wati".into()),
        }),
    )
    .await
    .expect("search");
    assert_eq!(searched["items"].as_array().unwrap().len(), 1);

    // rename
    let Json(patched) = stokku_api::routes::contacts::update(
        State(st.clone()),
        owner.clone(),
        Path(customer),
        Json(ContactPatch {
            name: Some("Ibu Wati Baru".into()),
            phone: None,
        }),
    )
    .await
    .expect("patch");
    assert_eq!(patched["name"], "Ibu Wati Baru");

    // bad type is refused
    let bad = create(
        State(st.clone()),
        owner.clone(),
        Json(ContactReq {
            kind: "reseller".into(),
            name: "X".into(),
            phone: None,
        }),
    )
    .await;
    assert!(bad.is_err(), "unknown type must be rejected");

    // an unused contact can go
    let unused = new_contact(&st, &owner, "customer", "Sekali Pakai").await;
    let Json(del) =
        stokku_api::routes::contacts::remove(State(st.clone()), owner.clone(), Path(unused))
            .await
            .expect("delete unused");
    assert_eq!(del["deleted"], true);

    // once it is on a payable, deletion is refused instead of orphaning the bill
    let Json(_) = create_payable(
        State(st.clone()),
        owner.clone(),
        Json(BillReq {
            contact_id: supplier,
            amount: 50_000,
            due_date: None,
            sale_id: None,
        }),
    )
    .await
    .expect("payable");
    let refused =
        stokku_api::routes::contacts::remove(State(st.clone()), owner.clone(), Path(supplier))
            .await;
    assert!(refused.is_err(), "contact on a payable must not be deleted");

    common::drop_db(st.pool.clone()).await;
}

#[tokio::test]
async fn payable_partial_payment_and_overpayment_refusal() {
    if common::admin_url().is_none() {
        eprintln!("SKIPPED: STOKKU_TEST_ADMIN_URL not set");
        return;
    }
    let (st, owner, _staff) = setup("payable").await;
    let supplier = new_contact(&st, &owner, "supplier", "CV Sumber Makmur").await;

    let Json(bill) = create_payable(
        State(st.clone()),
        owner.clone(),
        Json(BillReq {
            contact_id: supplier,
            amount: 100_000,
            due_date: None,
            sale_id: None,
        }),
    )
    .await
    .expect("payable");
    let bill_id: Uuid = serde_json::from_value(bill["id"].clone()).unwrap();
    assert_eq!(bill["outstanding"], 100_000);

    // pay 40.000 of 100.000
    let Json(pay1) = pay_payable(
        State(st.clone()),
        owner.clone(),
        Path(bill_id),
        Json(PaymentReq {
            amount: 40_000,
            business_date: Some("2026-11-26".into()),
            method: Some("cash".into()),
            category: None,
            outlet_id: None,
            note: None,
            op_id: None,
        }),
    )
    .await
    .expect("partial payment");
    assert_eq!(pay1["bill"]["paid_amount"], 40_000);
    assert_eq!(pay1["bill"]["outstanding"], 60_000);
    assert_eq!(pay1["settled"], false);

    // the money is in the cash book, linked to the bill
    let mut tx = st.pool.begin().await.unwrap();
    stokku_api::util::set_app_context(&mut tx, Some(owner.tenant_id), Some(owner.user_id))
        .await
        .unwrap();
    let (dir, amount, ref_type, ref_id): (String, i64, String, Uuid) = {
        let row = sqlx::query(
            "select direction, amount, ref_type, ref_id from cash_entry
             where ref_type = 'payable_payment' and ref_id = $1",
        )
        .bind(bill_id)
        .fetch_one(&mut *tx)
        .await
        .expect("cash entry for the payment");
        (
            row.get("direction"),
            row.get("amount"),
            row.get("ref_type"),
            row.get("ref_id"),
        )
    };
    assert_eq!(dir, "out");
    assert_eq!(amount, 40_000);
    assert_eq!(ref_type, "payable_payment");
    assert_eq!(ref_id, bill_id);
    tx.commit().await.unwrap();

    // 70.000 against a 60.000 remainder is refused, not clamped
    let over = pay_payable(
        State(st.clone()),
        owner.clone(),
        Path(bill_id),
        Json(PaymentReq {
            amount: 70_000,
            business_date: None,
            method: None,
            category: None,
            outlet_id: None,
            note: None,
            op_id: None,
        }),
    )
    .await;
    let msg = format!("{:?}", over.as_ref().err());
    assert!(over.is_err(), "overpayment must be refused");
    assert!(msg.contains("melebihi sisa"), "readable reason: {msg}");

    // the bill is untouched by the refused payment
    let Json(open) = list_payables(
        State(st.clone()),
        owner.clone(),
        Query(BillListQuery {
            contact_id: None,
            open: Some(true),
        }),
    )
    .await
    .expect("list open");
    assert_eq!(open["outstanding_total"], 60_000);

    // settle the rest
    let Json(pay2) = pay_payable(
        State(st.clone()),
        owner.clone(),
        Path(bill_id),
        Json(PaymentReq {
            amount: 60_000,
            business_date: Some("2026-11-26".into()),
            method: None,
            category: None,
            outlet_id: None,
            note: Some("pelunasan".into()),
            op_id: None,
        }),
    )
    .await
    .expect("final payment");
    assert_eq!(pay2["bill"]["outstanding"], 0);
    assert_eq!(pay2["settled"], true);

    let Json(open) = list_payables(
        State(st.clone()),
        owner.clone(),
        Query(BillListQuery {
            contact_id: None,
            open: Some(true),
        }),
    )
    .await
    .expect("list open after settle");
    assert_eq!(open["items"].as_array().unwrap().len(), 0);
    assert_eq!(open["outstanding_total"], 0);

    common::drop_db(st.pool.clone()).await;
}

#[tokio::test]
async fn cash_from_a_bill_is_not_booked_as_a_second_expense_or_revenue() {
    if common::admin_url().is_none() {
        eprintln!("SKIPPED: STOKKU_TEST_ADMIN_URL not set");
        return;
    }
    let (st, owner, _staff) = setup("billopex").await;
    let supplier = new_contact(&st, &owner, "supplier", "Pemasok").await;
    let customer = new_contact(&st, &owner, "customer", "Pelanggan").await;

    // A payable payment defaults to the stock category, which the opex rule
    // already excludes ("stok bukan beban"). Settling a supplier debt must not
    // appear as a new operating expense, or the same money is counted twice.
    let Json(bill) = create_payable(
        State(st.clone()),
        owner.clone(),
        Json(BillReq {
            contact_id: supplier,
            amount: 80_000,
            due_date: None,
            sale_id: None,
        }),
    )
    .await
    .expect("payable");
    let bill_id: Uuid = serde_json::from_value(bill["id"].clone()).unwrap();
    let Json(_paid) = pay_payable(
        State(st.clone()),
        owner.clone(),
        Path(bill_id),
        Json(PaymentReq {
            amount: 80_000,
            business_date: Some("2026-11-20".into()),
            method: None,
            category: None,
            outlet_id: None,
            note: None,
            op_id: None,
        }),
    )
    .await
    .expect("pay payable");

    // A receivable payment is money in against a sale already counted as
    // revenue, so it must not add revenue either.
    let Json(recv) = create_receivable(
        State(st.clone()),
        owner.clone(),
        Json(BillReq {
            contact_id: customer,
            amount: 50_000,
            due_date: None,
            sale_id: None,
        }),
    )
    .await
    .expect("receivable");
    let recv_id: Uuid = serde_json::from_value(recv["id"].clone()).unwrap();
    let Json(_received) = pay_receivable(
        State(st.clone()),
        owner.clone(),
        Path(recv_id),
        Json(PaymentReq {
            amount: 50_000,
            business_date: Some("2026-11-20".into()),
            method: None,
            category: None,
            outlet_id: None,
            note: None,
            op_id: None,
        }),
    )
    .await
    .expect("pay receivable");

    let Json(lr) = laba_rugi(
        State(st.clone()),
        owner.clone(),
        Query(stokku_api::routes::reports::LabaRugiQuery {
            from: Some("2026-11-01".into()),
            to: Some("2026-11-30".into()),
            compare: None,
        }),
    )
    .await
    .expect("report");
    assert_eq!(lr["revenue"], 0, "no sale, so no revenue");
    assert_eq!(lr["opex"], 0, "settling a stock debt is not opex");
    assert_eq!(lr["net_profit"], 0);

    // cross-check the cash book itself: both movements exist
    let Json(recv_list) = list_receivables(
        State(st.clone()),
        owner.clone(),
        Query(BillListQuery {
            contact_id: None,
            open: Some(true),
        }),
    )
    .await
    .expect("receivables");
    assert_eq!(recv_list["outstanding_total"], 0);

    let mut tx = st.pool.begin().await.unwrap();
    stokku_api::util::set_app_context(&mut tx, Some(owner.tenant_id), Some(owner.user_id))
        .await
        .unwrap();
    let directions: Vec<(String, i64)> =
        sqlx::query_as("select direction, amount from cash_entry order by created_at")
            .fetch_all(&mut *tx)
            .await
            .unwrap();
    tx.commit().await.unwrap();
    assert_eq!(directions.len(), 2);
    assert!(directions.contains(&("out".to_string(), 80_000)));
    assert!(directions.contains(&("in".to_string(), 50_000)));

    common::drop_db(st.pool.clone()).await;
}

#[tokio::test]
async fn bill_type_must_match_the_contact_type() {
    if common::admin_url().is_none() {
        eprintln!("SKIPPED: STOKKU_TEST_ADMIN_URL not set");
        return;
    }
    let (st, owner, _staff) = setup("billtype").await;
    let customer = new_contact(&st, &owner, "customer", "Pelanggan").await;

    // a payable against a customer is a data-entry mistake worth stopping
    let bad = create_payable(
        State(st.clone()),
        owner.clone(),
        Json(BillReq {
            contact_id: customer,
            amount: 10_000,
            due_date: None,
            sale_id: None,
        }),
    )
    .await;
    assert!(bad.is_err(), "payable requires a supplier contact");

    let zero = create_receivable(
        State(st.clone()),
        owner.clone(),
        Json(BillReq {
            contact_id: customer,
            amount: 0,
            due_date: None,
            sale_id: None,
        }),
    )
    .await;
    assert!(zero.is_err(), "zero-value bill is refused");

    common::drop_db(st.pool.clone()).await;
}

#[allow(dead_code)]
fn _qty_is_three_decimals() -> Decimal {
    Decimal::new(1_000, 3)
}
