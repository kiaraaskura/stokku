//! Export tests (T-407/T-408):
//! - staff gets 403 on every export path
//! - sales CSV row count and total reconcile with the report for the range
//! - the account archive is a real ZIP listing every business table
//! - cross-tenant isolation is structural: the export queries run under
//!   the caller's RLS context

mod common;

use axum::extract::{Query, State};
use axum::response::IntoResponse;
use axum::Json;
use rust_decimal::Decimal;
use sqlx::PgPool;
use stokku_api::auth::{signup, SignupReq};
use stokku_api::config::AppConfig;
use stokku_api::ctx::{AuthCtx, Role};
use stokku_api::routes::exports::{
    account_zip, cash_csv, laba_rugi_csv, sales_csv, stock_csv, stock_moves_csv, RangeQuery,
};
use stokku_api::routes::items::{create as create_item, CreateItemReq};
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

async fn body(resp: axum::response::Response) -> Vec<u8> {
    axum::body::to_bytes(resp.into_body(), usize::MAX)
        .await
        .expect("body")
        .to_vec()
}

async fn setup(tag: &str) -> (AppState, AuthCtx, AuthCtx, Uuid, Vec<Uuid>) {
    let pool = common::fresh_db(tag).await;
    let st = state(pool.clone());

    let email = format!("export-{tag}-{}@test.local", Uuid::now_v7().simple());
    let Json(tok) = signup(
        State(st.clone()),
        Json(SignupReq {
            email,
            password: "password-uji-12345678".into(),
            name: "Pemilik".into(),
            business_name: format!("Warung Export {tag}"),
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
            "export-staff-{tag}-{}@test.local",
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
    for name in ["Gula Ekspor", "Kopi Ekspor"] {
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
                sale_price: 12000,
                cost: Some(6000),
                min_stock: None,
                active: None,
                op_id: None,
            }),
        )
        .await
        .expect("item");
        let id: Uuid = serde_json::from_value(item["id"].clone()).unwrap();
        items.push(id);
        let Json(_mv) = create_move(
            State(st.clone()),
            owner.clone(),
            Json(StockMoveReq {
                item_id: id,
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
    }

    (st, owner, staff, outlet_id, items)
}

#[tokio::test]
async fn staff_is_refused_on_every_export_path() {
    if common::admin_url().is_none() {
        eprintln!("SKIPPED: STOKKU_TEST_ADMIN_URL not set");
        return;
    }
    let (st, _owner, staff, _outlet, _items) = setup("staff403").await;
    let cases: Vec<axum::response::Response> = vec![
        sales_csv(
            State(st.clone()),
            staff.clone(),
            Query(RangeQuery {
                from: None,
                to: None,
            }),
        )
        .await
        .expect_err("sales.csv 403")
        .into_response(),
        stock_csv(State(st.clone()), staff.clone())
            .await
            .expect_err("stock.csv 403")
            .into_response(),
        stock_moves_csv(
            State(st.clone()),
            staff.clone(),
            Query(RangeQuery {
                from: Some("2026-11-01".into()),
                to: Some("2026-11-30".into()),
            }),
        )
        .await
        .expect_err("stock-moves.csv 403")
        .into_response(),
        cash_csv(
            State(st.clone()),
            staff.clone(),
            Query(RangeQuery {
                from: Some("2026-11-01".into()),
                to: Some("2026-11-30".into()),
            }),
        )
        .await
        .expect_err("cash.csv 403")
        .into_response(),
        laba_rugi_csv(
            State(st.clone()),
            staff.clone(),
            Query(RangeQuery {
                from: None,
                to: None,
            }),
        )
        .await
        .expect_err("laba-rugi.csv 403")
        .into_response(),
        account_zip(State(st.clone()), staff)
            .await
            .expect_err("account.zip 403")
            .into_response(),
    ];
    for resp in cases {
        assert_eq!(resp.status(), 403);
    }
}

#[tokio::test]
async fn sales_csv_reconciles_with_the_report() {
    if common::admin_url().is_none() {
        eprintln!("SKIPPED: STOKKU_TEST_ADMIN_URL not set");
        return;
    }
    let (st, owner, _staff, outlet, items) = setup("reconcile").await;

    // two sales in November: 5 x 12.000 and 2 x 12.000 (same item)
    for (qty, _) in [(5i64, 0), (2, 1)] {
        let Json(sale) = create_sale(
            State(st.clone()),
            owner.clone(),
            Json(SaleReq {
                outlet_id: Some(outlet),
                business_date: Some("2026-11-25".into()),
                customer_id: None,
                discount: None,
                payment_method: "cash".into(),
                paid: Some(true),
                note: Some("ekspor".into()),
                lines: vec![SaleLineReq {
                    item_id: items[0],
                    qty: Decimal::from(qty),
                    unit_price: 12000,
                    discount: None,
                }],
                op_id: None,
            }),
        )
        .await
        .expect("sale");
        assert!(sale["id"].is_string());
    }

    // the CSV
    let resp = sales_csv(
        State(st.clone()),
        owner.clone(),
        Query(RangeQuery {
            from: Some("2026-11-01".into()),
            to: Some("2026-11-30".into()),
        }),
    )
    .await
    .expect("sales csv");
    let bytes = body(resp).await;
    let text = String::from_utf8(bytes).unwrap();
    let lines: Vec<&str> = text.trim_end().split("\r\n").collect();
    assert_eq!(
        lines[0],
        "nomor,tanggal,metode_bayar,lunas,mode,jumlah_baris,diskon,total,catatan"
    );
    assert_eq!(lines.len(), 3, "header + 2 sales: {text}");
    let total: i64 = lines[1..]
        .iter()
        .map(|l| l.split(',').nth(7).unwrap().parse::<i64>().unwrap())
        .sum();
    assert_eq!(total, 7 * 12000);

    // equals the report over the same range
    let Json(rep) = stokku_api::routes::reports::laba_rugi(
        State(st.clone()),
        owner,
        Query(stokku_api::routes::reports::LabaRugiQuery {
            from: Some("2026-11-01".into()),
            to: Some("2026-11-30".into()),
            compare: None,
        }),
    )
    .await
    .expect("report");
    assert_eq!(
        serde_json::from_value::<i64>(rep["revenue"].clone()).unwrap(),
        total,
        "CSV total must equal the report revenue"
    );
}

#[tokio::test]
async fn account_archive_is_a_complete_zip() {
    if common::admin_url().is_none() {
        eprintln!("SKIPPED: STOKKU_TEST_ADMIN_URL not set");
        return;
    }
    let (st, owner, _staff, outlet, items) = setup("archive").await;

    // one sale so the archive carries business data
    let Json(sale) = create_sale(
        State(st.clone()),
        owner.clone(),
        Json(SaleReq {
            outlet_id: Some(outlet),
            business_date: Some("2026-11-25".into()),
            customer_id: None,
            discount: None,
            payment_method: "cash".into(),
            paid: Some(true),
            note: None,
            lines: vec![SaleLineReq {
                item_id: items[0],
                qty: Decimal::new(5_000, 3),
                unit_price: 12000,
                discount: None,
            }],
            op_id: None,
        }),
    )
    .await
    .expect("sale");
    let sale_id: Uuid = serde_json::from_value(sale["id"].clone()).unwrap();

    let resp = account_zip(State(st.clone()), owner)
        .await
        .expect("archive");
    let bytes = body(resp).await;

    // ZIP magic + end-of-central-directory
    assert_eq!(&bytes[..4], b"PK\x03\x04", "local header magic");
    let eocd = find_eocd(&bytes).expect("EOCD present");
    let entry_count = u16::from_le_bytes([bytes[eocd + 10], bytes[eocd + 11]]) as usize;
    assert!(
        entry_count >= 9,
        "manifest + json + 7 csvs at least: {entry_count}"
    );

    // walk the central directory: names must cover the promised set
    let mut names = Vec::new();
    let cd_start = u32::from_le_bytes([
        bytes[eocd + 16],
        bytes[eocd + 17],
        bytes[eocd + 18],
        bytes[eocd + 19],
    ]) as usize;
    let mut p = cd_start;
    while p + 46 <= eocd {
        assert_eq!(&bytes[p..p + 4], b"PK\x01\x02");
        let name_len = u16::from_le_bytes([bytes[p + 28], bytes[p + 29]]) as usize;
        let name = String::from_utf8(bytes[p + 46..p + 46 + name_len].to_vec()).unwrap();
        names.push(name);
        p += 46 + name_len;
    }
    for required in [
        "manifest.json",
        "full_data.json",
        "items.csv",
        "stock_levels.csv",
        "stock_moves.csv",
        "sales_with_lines.csv",
        "cash_entries.csv",
        "contacts.csv",
        "laba_rugi_all_time.csv",
    ] {
        assert!(names.contains(&required.to_string()), "missing {required}");
    }

    // the archive carries the sale we just made (full_data.json)
    let fd_start = bytes
        .windows(9)
        .position(|w| w == b"full_data")
        .expect("full_data entry");
    let _ = fd_start;
    // JSON stores the UUID as its hyphenated text, not as 16 raw bytes.
    let sale_text = sale_id.to_string();
    assert!(
        bytes
            .windows(sale_text.len())
            .any(|w| w == sale_text.as_bytes()),
        "sale id present in the archive"
    );

    // full_data.json must be valid JSON with every table present as an array,
    // and its row counts must agree with manifest.json. Without this the
    // streamed writer could emit malformed JSON and every check above would
    // still pass.
    let raw = entry_body(&bytes, "full_data.json").expect("full_data.json entry");
    let data: serde_json::Value =
        serde_json::from_slice(&raw).expect("full_data.json parses as JSON");
    let obj = data.as_object().expect("full_data.json is an object");
    let manifest_raw = entry_body(&bytes, "manifest.json").expect("manifest.json entry");
    let manifest: serde_json::Value =
        serde_json::from_slice(&manifest_raw).expect("manifest parses");
    for (table, count) in manifest["counts"].as_object().unwrap() {
        let arr = obj
            .get(table)
            .unwrap_or_else(|| panic!("{table} missing from full_data.json"))
            .as_array()
            .unwrap_or_else(|| panic!("{table} is not an array"));
        assert_eq!(
            arr.len() as i64,
            count.as_i64().unwrap(),
            "{table} row count disagrees with the manifest"
        );
    }
    assert_eq!(
        obj.get("sale").and_then(|v| v.as_array()).map(|a| a.len()),
        Some(1),
        "the sale is in full_data.json"
    );

    // sale_line has no tenant_id of its own, so a direct read of it would
    // leak other shops' lines. Every line in the archive must belong to a sale
    // that is itself in the archive.
    let sale_ids: std::collections::HashSet<String> = obj["sale"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| s["id"].as_str().unwrap().to_string())
        .collect();
    for line in obj["sale_line"].as_array().unwrap() {
        let parent = line["sale_id"].as_str().unwrap();
        assert!(
            sale_ids.contains(parent),
            "sale_line {parent} does not belong to any sale in this archive"
        );
    }

    common::drop_db(st.pool.clone()).await;
}

/// Read a STORED entry's body from the local headers (our writer never
/// compresses, so data length sits at offset 18 of each local header).
fn entry_body(bytes: &[u8], want: &str) -> Option<Vec<u8>> {
    let mut p = 0usize;
    while p + 30 <= bytes.len() {
        if &bytes[p..p + 4] != b"PK\x03\x04" {
            return None;
        }
        let size = u32::from_le_bytes([bytes[p + 18], bytes[p + 19], bytes[p + 20], bytes[p + 21]])
            as usize;
        let name_len = u16::from_le_bytes([bytes[p + 26], bytes[p + 27]]) as usize;
        let extra_len = u16::from_le_bytes([bytes[p + 28], bytes[p + 29]]) as usize;
        let name = String::from_utf8(bytes[p + 30..p + 30 + name_len].to_vec()).ok()?;
        let data_start = p + 30 + name_len + extra_len;
        if name == want {
            return Some(bytes[data_start..data_start + size].to_vec());
        }
        p = data_start + size;
    }
    None
}

fn find_eocd(b: &[u8]) -> Option<usize> {
    if b.len() < 22 {
        return None;
    }
    for i in (0..b.len() - 21).rev() {
        if &b[i..i + 4] == b"PK\x05\x06" {
            return Some(i);
        }
    }
    None
}
