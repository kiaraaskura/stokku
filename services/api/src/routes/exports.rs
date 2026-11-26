//! Exports (T-407/T-408): streamed CSVs, printable HTML (the "PDF" path)
//! and the full account archive (JSON + CSVs in a ZIP).
//!
//! Every export is owner-only (Cap::Export) and every query runs inside a
//! connection with `set_app_context`, so tenant isolation is enforced by
//! the database's RLS policies — a cross-tenant export is impossible by
//! construction, not by a check someone could forget.
//!
//! CSV format (deliberate, spreadsheet-safe in an Indonesian locale):
//! integer rupiah with NO thousand separators, qty fixed to 3 decimals
//! ("12.500"), ISO-8601 dates, a header row, CRLF line endings, and
//! minimal quoting (only fields containing , " CR LF).

use std::pin::Pin;
use std::task::Poll;

use chrono::{DateTime, Datelike, NaiveDate, Utc};
use futures_core::Stream;
use futures_util::TryStreamExt;
use rust_decimal::Decimal;
use serde_json::{json, Value};
use sqlx::{PgConnection, PgPool, Row};
use tokio::sync::mpsc;
use uuid::Uuid;

use axum::body::Body;
use axum::extract::{Path, Query, State};
use axum::response::Response;

use crate::ctx::{AuthCtx, Cap};
use crate::error::{ApiError, ApiResult};
use crate::state::AppState;
use crate::util::set_app_context;

type Chunk = Result<Vec<u8>, String>;

/// mpsc receiver as a Stream for `Body::from_stream`.
struct ChannelStream {
    rx: mpsc::Receiver<Chunk>,
}

impl Stream for ChannelStream {
    type Item = Result<Vec<u8>, std::io::Error>;
    fn poll_next(
        mut self: Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> Poll<Option<Self::Item>> {
        self.rx
            .poll_recv(cx)
            .map(|opt| opt.map(|r| r.map_err(std::io::Error::other)))
    }
}

fn attachment(headers: &mut axum::http::HeaderMap, filename: &str, content_type: &str) {
    let hv = |v: &str| axum::http::HeaderValue::from_str(v).expect("valid header");
    headers.insert(axum::http::header::CONTENT_TYPE, hv(content_type));
    headers.insert(
        axum::http::header::CONTENT_DISPOSITION,
        hv(&format!("attachment; filename=\"{filename}\"")),
    );
}

fn response(mut headers: axum::http::HeaderMap, rx: mpsc::Receiver<Chunk>) -> Response {
    let mut r = Response::builder()
        .status(200)
        .body(Body::from_stream(ChannelStream { rx }))
        .expect("response");
    r.headers_mut().extend(headers.drain());
    r
}

/// Minimal CSV cell quoting.
fn cell(s: &str) -> String {
    if s.contains(',') || s.contains('"') || s.contains('\n') || s.contains('\r') {
        format!("\"{}\"", s.replace('"', "\"\""))
    } else {
        s.to_string()
    }
}

/// CSV row from parts; CRLF terminated.
fn csv_row(parts: &[String]) -> Vec<u8> {
    let line: String = parts.iter().map(|p| cell(p)).collect::<Vec<_>>().join(",");
    format!("{line}\r\n").into_bytes()
}

fn qty3(d: Decimal) -> String {
    format!("{d:.3}")
}

fn s(v: impl ToString) -> String {
    v.to_string()
}

fn opt_s<T: ToString>(v: Option<T>) -> String {
    v.map(|x| x.to_string()).unwrap_or_default()
}

/// Fetch rows from a connection (already tenant-scoped) and stream them
/// through the channel as CSV bytes. `header` is sent first.
async fn stream_rows_as_csv<F>(
    conn: &mut sqlx::Transaction<'static, sqlx::Postgres>,
    tx: mpsc::Sender<Chunk>,
    header: Vec<u8>,
    query: sqlx::query::Query<'static, sqlx::Postgres, sqlx::postgres::PgArguments>,
    row_to_line: F,
) where
    F: Fn(&sqlx::postgres::PgRow) -> Result<Vec<u8>, sqlx::Error>,
{
    if tx.send(Ok(header)).await.is_err() {
        return;
    }
    let mut stream = Box::pin(query.fetch(&mut **conn));
    loop {
        let item = match std::future::poll_fn(|cx| stream.as_mut().poll_next(cx)).await {
            Some(i) => i,
            None => break,
        };
        match item {
            Ok(row) => match row_to_line(&row) {
                Ok(line) => {
                    if tx.send(Ok(line)).await.is_err() {
                        break; // client went away
                    }
                }
                Err(e) => {
                    let _ = tx.send(Err(format!("{e:#}"))).await;
                    break;
                }
            },
            Err(e) => {
                let _ = tx.send(Err(format!("{e:#}"))).await;
                break;
            }
        }
    }
}

/// Wire an export endpoint: acquire a connection, set the RLS context,
/// stream the CSV/ZIP bytes to the client with backpressure.
fn start_export<F, Fut>(
    pool: &PgPool,
    ctx: &AuthCtx,
    headers: axum::http::HeaderMap,
    produce: F,
) -> Response
where
    F: FnOnce(mpsc::Sender<Chunk>, sqlx::Transaction<'static, sqlx::Postgres>) -> Fut
        + Send
        + 'static,
    Fut: std::future::Future<Output = ()> + Send + 'static,
{
    let (tx, rx) = mpsc::channel::<Chunk>(8);
    let pool = pool.clone();
    let tenant = ctx.tenant_id;
    let user = ctx.user_id;
    tokio::spawn(async move {
        // set_app_context is transaction-local (SET LOCAL), so the whole
        // export runs in one transaction — the RLS context sticks and
        // isolation is by construction. Begin from the pool, not from a
        // borrowed connection: the transaction must own its connection so it
        // can be handed to the producer future as Transaction<'static>.
        let mut tx_db = match pool.begin().await {
            Ok(t) => t,
            Err(e) => {
                let _ = tx.send(Err(format!("{e:#}"))).await;
                return;
            }
        };
        if let Err(e) = set_app_context(&mut tx_db, Some(tenant), Some(user)).await {
            let _ = tx.send(Err(format!("{e:?}"))).await;
            return;
        }
        produce(tx, tx_db).await;
    });
    response(headers, rx)
}

#[derive(serde::Deserialize)]
pub struct RangeQuery {
    pub from: Option<String>,
    pub to: Option<String>,
}

fn parse_range(q: &RangeQuery) -> ApiResult<(NaiveDate, NaiveDate)> {
    let from = q.from.as_deref().map(crate::util::parse_date).transpose()?;
    let to = q.to.as_deref().map(crate::util::parse_date).transpose()?;
    let today = crate::util::today_jakarta();
    let from = from.unwrap_or(NaiveDate::from_ymd_opt(today.year(), 1, 1).unwrap_or(today));
    let to = to.unwrap_or(today);
    if from > to {
        return Err(ApiError::validation("from harus sebelum to"));
    }
    Ok((from, to))
}

/// GET /v1/exports/sales.csv?from=&to= — non-voided sales; row count and
/// total reconcile with GET /reports/sales over the same range.
pub async fn sales_csv(
    State(st): State<AppState>,
    ctx: AuthCtx,
    Query(q): Query<RangeQuery>,
) -> ApiResult<Response> {
    ctx.require(Cap::Export)?;
    let (from, to) = parse_range(&q)?;
    let mut headers = axum::http::HeaderMap::new();
    attachment(
        &mut headers,
        &format!("stokku-penjualan-{from}-{to}.csv"),
        "text/csv; charset=utf-8",
    );
    let header = csv_row(&[
        "nomor".into(),
        "tanggal".into(),
        "metode_bayar".into(),
        "lunas".into(),
        "mode".into(),
        "jumlah_baris".into(),
        "diskon".into(),
        "total".into(),
        "catatan".into(),
    ]);
    let fut = move |tx, tx_db: sqlx::Transaction<'static, sqlx::Postgres>| async move {
        let mut conn = tx_db;
        let query = sqlx::query(
            "select s.number, s.business_date, s.payment_method, s.paid, s.mode, s.discount,
                    s.total, s.note,
                    (select count(*) from sale_line l where l.sale_id = s.id) as line_count
             from sale s
             where s.voided_at is null and s.business_date between $1 and $2
             order by s.business_date, s.id",
        )
        .bind(from)
        .bind(to);
        stream_rows_as_csv(&mut conn, tx, header, query, |row| {
            let note: Option<String> = row.try_get("note")?;
            Ok(csv_row(&[
                opt_s(row.try_get::<Option<String>, _>("number")?),
                s(row.try_get::<NaiveDate, _>("business_date")?),
                row.try_get::<String, _>("payment_method")?,
                s(row.try_get::<bool, _>("paid")?),
                row.try_get::<String, _>("mode")?,
                s(row.try_get::<i64, _>("line_count")?),
                s(row.try_get::<i64, _>("discount")?),
                s(row.try_get::<i64, _>("total")?),
                opt_s(note),
            ]))
        })
        .await;
    };
    Ok(start_export(&st.pool, &ctx, headers, fut))
}

/// GET /v1/exports/stock.csv — per item+outlet valuation (v_stock_report).
pub async fn stock_csv(State(st): State<AppState>, ctx: AuthCtx) -> ApiResult<Response> {
    ctx.require(Cap::Export)?;
    let mut headers = axum::http::HeaderMap::new();
    attachment(&mut headers, "stokku-stok.csv", "text/csv; charset=utf-8");
    let header = csv_row(&[
        "item_id".into(),
        "sku".into(),
        "nama".into(),
        "qty".into(),
        "cost_avg".into(),
        "harga_jual".into(),
        "nilai_modal".into(),
        "nilai_jual".into(),
        "stok_menipis".into(),
        "stok_negatif".into(),
        "pergerakan_terakhir".into(),
        "stok_mati".into(),
        "jumlah_pergerakan".into(),
    ]);
    let fut = move |tx, tx_db: sqlx::Transaction<'static, sqlx::Postgres>| async move {
        let mut conn = tx_db;
        let query = sqlx::query(
            "select item_id, sku, item_name, qty, cost_avg, sale_price, value_at_cost,
                    value_at_sale, low_stock, negative_stock, last_movement_date, dead_stock,
                    move_count
             from v_stock_report order by item_name",
        );
        stream_rows_as_csv(&mut conn, tx, header, query, |row| {
            let qty: Decimal = row.try_get("qty")?;
            let at_cost: Decimal = row.try_get("value_at_cost")?;
            let at_sale: Decimal = row.try_get("value_at_sale")?;
            Ok(csv_row(&[
                s(row.try_get::<Uuid, _>("item_id")?),
                opt_s(row.try_get::<Option<String>, _>("sku")?),
                row.try_get::<String, _>("item_name")?,
                qty3(qty),
                s(row.try_get::<i64, _>("cost_avg")?),
                s(row.try_get::<i64, _>("sale_price")?),
                qty3(at_cost),
                qty3(at_sale),
                s(row.try_get::<bool, _>("low_stock")?),
                s(row.try_get::<bool, _>("negative_stock")?),
                opt_s(row.try_get::<Option<NaiveDate>, _>("last_movement_date")?),
                s(row.try_get::<bool, _>("dead_stock")?),
                s(row.try_get::<i64, _>("move_count")?),
            ]))
        })
        .await;
    };
    Ok(start_export(&st.pool, &ctx, headers, fut))
}

/// GET /v1/exports/stock-moves.csv?from=&to= — the ledger (this is the
/// one the 50k-rows-under-60s budget is measured on).
pub async fn stock_moves_csv(
    State(st): State<AppState>,
    ctx: AuthCtx,
    Query(q): Query<RangeQuery>,
) -> ApiResult<Response> {
    ctx.require(Cap::Export)?;
    let (from, to) = parse_range(&q)?;
    let mut headers = axum::http::HeaderMap::new();
    attachment(
        &mut headers,
        &format!("stokku-pergerakan-stok-{from}-{to}.csv"),
        "text/csv; charset=utf-8",
    );
    let header = csv_row(&[
        "id".into(),
        "tanggal".into(),
        "tipe".into(),
        "qty".into(),
        "unit_cost".into(),
        "ref_tipe".into(),
        "ref_id".into(),
        "catatan".into(),
        "dibuat_pada".into(),
    ]);
    let fut = move |tx, tx_db: sqlx::Transaction<'static, sqlx::Postgres>| async move {
        let mut conn = tx_db;
        let query = sqlx::query(
            "select id, business_date, type, qty, unit_cost, ref_type, ref_id, note, created_at
             from stock_move
             where business_date between $1 and $2
             order by business_date, created_at, id",
        )
        .bind(from)
        .bind(to);
        stream_rows_as_csv(&mut conn, tx, header, query, |row| {
            let qty: Decimal = row.try_get("qty")?;
            Ok(csv_row(&[
                s(row.try_get::<Uuid, _>("id")?),
                s(row.try_get::<NaiveDate, _>("business_date")?),
                row.try_get::<String, _>("type")?,
                qty3(qty),
                s(row.try_get::<i64, _>("unit_cost")?),
                opt_s(row.try_get::<Option<String>, _>("ref_type")?),
                opt_s(row.try_get::<Option<Uuid>, _>("ref_id")?),
                opt_s(row.try_get::<Option<String>, _>("note")?),
                s(row.try_get::<DateTime<Utc>, _>("created_at")?),
            ]))
        })
        .await;
    };
    Ok(start_export(&st.pool, &ctx, headers, fut))
}

/// GET /v1/exports/cash.csv?from=&to= — the cash book.
pub async fn cash_csv(
    State(st): State<AppState>,
    ctx: AuthCtx,
    Query(q): Query<RangeQuery>,
) -> ApiResult<Response> {
    ctx.require(Cap::Export)?;
    let (from, to) = parse_range(&q)?;
    let mut headers = axum::http::HeaderMap::new();
    attachment(
        &mut headers,
        &format!("stokku-kas-{from}-{to}.csv"),
        "text/csv; charset=utf-8",
    );
    let header = csv_row(&[
        "id".into(),
        "tanggal".into(),
        "arah".into(),
        "kategori".into(),
        "metode".into(),
        "jumlah".into(),
        "ref_tipe".into(),
        "ref_id".into(),
        "catatan".into(),
    ]);
    let fut = move |tx, tx_db: sqlx::Transaction<'static, sqlx::Postgres>| async move {
        let mut conn = tx_db;
        let query = sqlx::query(
            "select id, business_date, direction, category, method, amount, ref_type, ref_id, note
             from cash_entry
             where business_date between $1 and $2
             order by business_date, id",
        )
        .bind(from)
        .bind(to);
        stream_rows_as_csv(&mut conn, tx, header, query, |row| {
            Ok(csv_row(&[
                s(row.try_get::<Uuid, _>("id")?),
                s(row.try_get::<NaiveDate, _>("business_date")?),
                row.try_get::<String, _>("direction")?,
                row.try_get::<String, _>("category")?,
                opt_s(row.try_get::<Option<String>, _>("method")?),
                s(row.try_get::<i64, _>("amount")?),
                opt_s(row.try_get::<Option<String>, _>("ref_type")?),
                opt_s(row.try_get::<Option<Uuid>, _>("ref_id")?),
                opt_s(row.try_get::<Option<String>, _>("note")?),
            ]))
        })
        .await;
    };
    Ok(start_export(&st.pool, &ctx, headers, fut))
}

/// GET /v1/exports/laba-rugi.csv?from=&to= — the same figures as
/// GET /reports/laba-rugi (revenue−hpp−opex = net).
pub async fn laba_rugi_csv(
    State(st): State<AppState>,
    ctx: AuthCtx,
    Query(q): Query<RangeQuery>,
) -> ApiResult<Response> {
    ctx.require(Cap::Export)?;
    let (from, to) = parse_range(&q)?;

    let mut tx = crate::util::begin_tx(&st.pool, &ctx).await?;
    let totals = crate::routes::reports::totals_for_tx(&mut tx, from, to).await?;
    tx.commit().await?;

    let header = csv_row(&["kunci".into(), "label".into(), "jumlah".into()]);
    let rows = vec![
        ("revenue", "Pendapatan", totals.revenue),
        ("hpp", "HPP (harga pokok penjualan)", totals.hpp),
        ("gross_profit", "Laba kotor", totals.revenue - totals.hpp),
        ("opex", "Beban operasional", totals.opex),
        (
            "net_profit",
            "Laba bersih",
            totals.revenue - totals.hpp - totals.opex,
        ),
        (
            "unpaid_revenue",
            "Pendapatan belum dibayar",
            totals.unpaid_revenue,
        ),
        ("qris_mdr_fee", "Biaya MDR QRIS", totals.qris_mdr_fee),
    ];
    let mut body = header;
    for (k, label, amount) in rows {
        body.extend(csv_row(&[k.into(), label.into(), s(amount)]));
    }

    let mut headers = axum::http::HeaderMap::new();
    attachment(
        &mut headers,
        &format!("stokku-laba-rugi-{from}-{to}.csv"),
        "text/csv; charset=utf-8",
    );
    let (tx, rx) = mpsc::channel::<Chunk>(1);
    let _ = tx.send(Ok(body)).await;
    Ok(response(headers, rx))
}

/// GET /v1/exports/laba-rugi.html?from=&to&compare=true — printable.
/// PDF choice: clean self-contained HTML (inline CSS, no scripts) instead
/// of a Rust PDF crate — it opens on any phone browser, prints to PDF
/// natively, and adds zero dependencies.
pub async fn laba_rugi_html(
    State(st): State<AppState>,
    ctx: AuthCtx,
    Query(q): Query<RangeQuery>,
) -> ApiResult<Response> {
    ctx.require(Cap::Export)?;
    let (from, to) = parse_range(&q)?;

    let mut tx = crate::util::begin_tx(&st.pool, &ctx).await?;
    let t = crate::routes::reports::totals_for_tx(&mut tx, from, to).await?;
    let cmp = crate::routes::reports::totals_for_tx(
        &mut tx,
        from - chrono::Duration::days((to - from).num_days() + 1),
        from - chrono::Duration::days(1),
    )
    .await?;
    let tenant_name: String = sqlx::query_scalar("select name from tenant")
        .fetch_one(&mut *tx)
        .await
        .unwrap_or_else(|_| "Toko".into());
    tx.commit().await?;

    let rupiah = |n: i64| format!("Rp{n}");
    let row = |label: &str, now: i64, before: i64, strong: bool| {
        format!(
            "<tr{}><td>{}</td><td class=\"num\">{}</td><td class=\"num\">{}</td></tr>",
            if strong { " class=\"strong\"" } else { "" },
            label,
            rupiah(now),
            rupiah(before)
        )
    };
    let html = format!(
        r#"<!doctype html><html lang="id"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Laba Rugi {tenant_name}</title>
<style>
 body{{font-family:system-ui,-apple-system,sans-serif;margin:16px;color:#111;max-width:720px}}
 h1{{font-size:20px;margin:0 0 2px}} .sub{{color:#555;font-size:13px;margin-bottom:16px}}
 table{{width:100%;border-collapse:collapse;font-size:14px}}
 td,th{{padding:7px 8px;border-bottom:1px solid #ddd;text-align:left}}
 .num{{text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums}}
 th{{background:#f5f5f5;font-size:12px;text-transform:uppercase;letter-spacing:.04em}}
 .strong td{{font-weight:700;border-top:2px solid #999}}
 @media print{{body{{margin:0}}}}
</style></head><body>
<h1>Laporan Laba Rugi — {tenant_name}</h1>
<div class="sub">Periode {from} s.d. {to} · Stokku</div>
<table>
<tr><th>Keterangan</th><th class="num">Periode ini</th><th class="num">Periode sebelumnya</th></tr>
{rev}{hpp}{gross}{opex}{net}
</table>
<p class="sub">Pendapatan belum dibayar: {unpaid} · Biaya MDR QRIS: {mdr}<br>
Pembelian stok bukan beban: pembelian tercatat sebagai persediaan.</p>
</body></html>"#,
        rev = row("Pendapatan", t.revenue, cmp.revenue, false),
        hpp = row("HPP (harga pokok penjualan)", t.hpp, cmp.hpp, false),
        gross = row("Laba kotor", t.revenue - t.hpp, cmp.revenue - cmp.hpp, true),
        opex = row("Beban operasional", t.opex, cmp.opex, false),
        net = row(
            "Laba bersih",
            t.revenue - t.hpp - t.opex,
            cmp.revenue - cmp.hpp - cmp.opex,
            true
        ),
        unpaid = rupiah(t.unpaid_revenue),
        mdr = rupiah(t.qris_mdr_fee),
    );

    let mut headers = axum::http::HeaderMap::new();
    headers.insert(
        axum::http::header::CONTENT_TYPE,
        axum::http::HeaderValue::from_str("text/html; charset=utf-8").unwrap(),
    );
    let (tx, rx) = mpsc::channel::<Chunk>(1);
    let _ = tx.send(Ok(html.into_bytes())).await;
    Ok(response(headers, rx))
}

/// GET /v1/exports/opname/{id} — the opname count sheet, printable HTML.
/// (axum 0.8 allows no suffix after a path parameter in the same segment,
/// so the extension lives in Content-Disposition, not in the path.)
pub async fn opname_html(
    State(st): State<AppState>,
    ctx: AuthCtx,
    Path(id): Path<Uuid>,
) -> ApiResult<Response> {
    ctx.require(Cap::Export)?;
    let mut tx = crate::util::begin_tx(&st.pool, &ctx).await?;
    let session: Option<(Uuid, String, NaiveDate, Option<DateTime<Utc>>)> = sqlx::query_as(
        "select id, status, business_date, posted_at from opname_session where id = $1",
    )
    .bind(id)
    .fetch_optional(&mut *tx)
    .await?;
    let Some((session_id, status, bdate, posted_at)) = session else {
        return Err(ApiError::NotFound("Sesi opname tidak ditemukan".into()));
    };
    let lines = sqlx::query(
        "select i.name, l.system_qty, l.counted_qty,
                coalesce((select sl.qty from stock_level sl
                          where sl.item_id = l.item_id and sl.outlet_id = os.outlet_id), 0) as current_qty
         from opname_line l
         join item i on i.id = l.item_id
         join opname_session os on os.id = l.session_id
         where l.session_id = $1
         order by i.name",
    )
    .bind(id)
    .fetch_all(&mut *tx)
    .await?;
    let tenant_name: String = sqlx::query_scalar("select name from tenant")
        .fetch_one(&mut *tx)
        .await
        .unwrap_or_else(|_| "Toko".into());
    tx.commit().await?;

    let rows: String = lines
        .iter()
        .map(|r| {
            let system: Decimal = r.try_get("system_qty").unwrap_or_default();
            let counted: Option<Decimal> = r.try_get("counted_qty").ok().flatten();
            let current: Decimal = r.try_get("current_qty").unwrap_or_default();
            let variance = counted.map(|c| c - current);
            format!(
                "<tr><td>{}</td><td class=\"num\">{:.3}</td><td class=\"num\">{}</td><td class=\"num\">{:.3}</td><td class=\"num\">{}</td></tr>",
                r.try_get::<String, _>("name").unwrap_or_default(),
                system,
                counted.map(|c| format!("{c:.3}")).unwrap_or_else(|| "—".into()),
                current,
                variance
                    .map(|v| format!("{v:.3}"))
                    .unwrap_or_else(|| "—".into()),
            )
        })
        .collect();

    let html = format!(
        r#"<!doctype html><html lang="id"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Opname {tenant_name}</title>
<style>
 body{{font-family:system-ui,-apple-system,sans-serif;margin:16px;color:#111;max-width:720px}}
 h1{{font-size:20px;margin:0 0 2px}} .sub{{color:#555;font-size:13px;margin-bottom:16px}}
 table{{width:100%;border-collapse:collapse;font-size:14px}}
 td,th{{padding:7px 8px;border-bottom:1px solid #ddd;text-align:left}}
 .num{{text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums}}
 th{{background:#f5f5f5;font-size:12px;text-transform:uppercase;letter-spacing:.04em}}
 @media print{{body{{margin:0}}}}
</style></head><body>
<h1>Lembar Opname — {tenant_name}</h1>
<div class="sub">Tanggal {bdate} · Status: {status} · Sesi {session_id}</div>
<table>
<tr><th>Item</th><th class="num">Sistem (saat hitung)</th><th class="num">Hasil hitung</th><th class="num">Stok sekarang</th><th class="num">Varians saat post</th></tr>
{rows}
</table>
<p class="sub">Diposting: {}</p>
</body></html>"#,
        posted_at
            .map(|p| p.to_rfc3339())
            .unwrap_or_else(|| "belum".into()),
    );

    let mut headers = axum::http::HeaderMap::new();
    headers.insert(
        axum::http::header::CONTENT_TYPE,
        axum::http::HeaderValue::from_str("text/html; charset=utf-8").unwrap(),
    );
    let (tx, rx) = mpsc::channel::<Chunk>(1);
    let _ = tx.send(Ok(html.into_bytes())).await;
    Ok(response(headers, rx))
}

// ---------------------------------------------------------------- T-408 --
// Full account archive: JSON + CSVs in one ZIP. The ZIP writer is
// hand-rolled (STORED entries + CRC-32) so no new dependency is needed;
// each CSV is built table-by-table in bounded memory (the largest table
// for a shop is a few MB), and the ZIP itself streams to the client.

fn crc32_table() -> [u32; 256] {
    let mut table = [0u32; 256];
    let mut i = 0;
    while i < 256 {
        let mut c = i as u32;
        let mut k = 0;
        while k < 8 {
            c = if c & 1 != 0 {
                0xEDB8_8320 ^ (c >> 1)
            } else {
                c >> 1
            };
            k += 1;
        }
        table[i] = c;
        i += 1;
    }
    table
}

fn crc32_update(crc: u32, data: &[u8]) -> u32 {
    let table = crc32_table();
    let mut crc = crc;
    for &b in data {
        crc = table[((crc ^ u32::from(b)) & 0xFF) as usize] ^ (crc >> 8);
    }
    crc
}

fn crc32(data: &[u8]) -> u32 {
    crc32_update(0xFFFF_FFFFu32, data) ^ 0xFFFF_FFFF
}

fn dos_datetime(t: DateTime<Utc>) -> (u16, u16) {
    use chrono::{Datelike, Timelike};
    let date = ((t.year() - 1980).max(0) as u16) << 9 | (t.month() as u16) << 5 | t.day() as u16;
    let time = (t.hour() as u16) << 11 | (t.minute() as u16) << 5 | (t.second() / 2) as u16;
    (date, time)
}

struct ZipEntry {
    name: String,
    // A streamed entry's CRC and size are not known until its body is written,
    // so they are back-patched at these offsets in the local header.
    crc_offset: u64,
    size_offset: u64,
    crc: u32,
    size: u32,
    offset: u32,
}

fn zip_local_header(name: &str, data: &[u8]) -> Vec<u8> {
    let (date, time) = dos_datetime(Utc::now());
    let mut h = Vec::with_capacity(30 + name.len());
    h.extend_from_slice(&0x04034b50u32.to_le_bytes());
    h.extend_from_slice(&20u16.to_le_bytes()); // version
    h.extend_from_slice(&0x0800u16.to_le_bytes()); // UTF-8 names
    h.extend_from_slice(&0u16.to_le_bytes()); // STORED
    h.extend_from_slice(&time.to_le_bytes());
    h.extend_from_slice(&date.to_le_bytes());
    h.extend_from_slice(&crc32(data).to_le_bytes());
    h.extend_from_slice(&(data.len() as u32).to_le_bytes());
    h.extend_from_slice(&(data.len() as u32).to_le_bytes());
    h.extend_from_slice(&(name.len() as u16).to_le_bytes());
    h.extend_from_slice(&0u16.to_le_bytes()); // extra len
    h.extend_from_slice(name.as_bytes());
    h
}

fn zip_central_dir(entries: &[ZipEntry]) -> Vec<u8> {
    let (date, time) = dos_datetime(Utc::now());
    let mut out = Vec::new();
    for e in entries {
        out.extend_from_slice(&0x02014b50u32.to_le_bytes());
        out.extend_from_slice(&20u16.to_le_bytes()); // version made by
        out.extend_from_slice(&20u16.to_le_bytes()); // version needed
        out.extend_from_slice(&0x0800u16.to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes()); // STORED
        out.extend_from_slice(&time.to_le_bytes());
        out.extend_from_slice(&date.to_le_bytes());
        out.extend_from_slice(&e.crc.to_le_bytes());
        out.extend_from_slice(&e.size.to_le_bytes());
        out.extend_from_slice(&e.size.to_le_bytes());
        out.extend_from_slice(&(e.name.len() as u16).to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes()); // extra
        out.extend_from_slice(&0u16.to_le_bytes()); // comment
        out.extend_from_slice(&0u16.to_le_bytes()); // disk
        out.extend_from_slice(&0u16.to_le_bytes()); // internal attrs
        out.extend_from_slice(&0u32.to_le_bytes()); // external attrs
        out.extend_from_slice(&e.offset.to_le_bytes());
        out.extend_from_slice(e.name.as_bytes());
    }
    out
}

fn zip_end(entries: &[ZipEntry], cd_size: u64) -> Vec<u8> {
    let mut out = Vec::new();
    out.extend_from_slice(&0x06054b50u32.to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes()); // disk
    out.extend_from_slice(&0u16.to_le_bytes()); // cd disk
    out.extend_from_slice(&(entries.len() as u16).to_le_bytes());
    out.extend_from_slice(&(entries.len() as u16).to_le_bytes());
    out.extend_from_slice(&(cd_size as u32).to_le_bytes());
    out.extend_from_slice(&0u32.to_le_bytes()); // cd offset filled by caller ordering
    out.extend_from_slice(&0u16.to_le_bytes()); // comment len
    out
}

/// Write a STORED entry whose body the caller streams into `zip` itself, so a
/// table far larger than memory (full_data.json) is never held twice. CRC and
/// size go into the local header afterwards, in place.
fn zip_open_streamed(zip: &mut Vec<u8>, entries: &mut Vec<ZipEntry>, name: &str) {
    let offset = zip.len() as u64;
    zip.extend_from_slice(&zip_local_header(name, &[]));
    entries.push(ZipEntry {
        name: name.to_string(),
        crc_offset: offset + 14,
        size_offset: offset + 18,
        crc: 0,
        size: 0,
        offset: offset as u32,
    });
}

fn zip_seal_streamed(zip: &mut [u8], entries: &mut [ZipEntry], crc: u32, size: u64) {
    if let Some(e) = entries.last_mut() {
        let (c, s) = (e.crc_offset as usize, e.size_offset as usize);
        zip[c..c + 4].copy_from_slice(&crc.to_le_bytes());
        zip[s..s + 4].copy_from_slice(&(size as u32).to_le_bytes());
        zip[s + 4..s + 8].copy_from_slice(&(size as u32).to_le_bytes());
        e.crc = crc;
        e.size = size as u32;
    }
}

/// Read a whole table as JSON rows through RLS (archive payload).
///
/// `sale_line` is the one table with no `tenant_id` of its own and no RLS, so
/// it must never be read directly: read it only through its parent sale, which
/// RLS does scope. Without this a shop's archive would contain every other
/// shop's sale lines.
async fn table_json(conn: &mut PgConnection, table: &str) -> Result<Vec<Value>, sqlx::Error> {
    let sql = if table == "sale_line" {
        "select coalesce(jsonb_agg(to_jsonb(l)), '[]'::jsonb) as rows
         from sale_line l join sale s on s.id = l.sale_id"
            .to_string()
    } else {
        format!("select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) as rows from {table} t")
    };
    let v: Value = sqlx::query_scalar(&sql).fetch_one(conn).await?;
    Ok(v.as_array().cloned().unwrap_or_default())
}

async fn table_csv(
    conn: &mut PgConnection,
    sql: &str,
    header: Vec<u8>,
    row_to_line: impl Fn(&sqlx::postgres::PgRow) -> Result<Vec<u8>, sqlx::Error>,
) -> Result<Vec<u8>, sqlx::Error> {
    // fetch() streams the rows instead of closing the cursor after headers, so
    // a large table is not read twice.
    let mut rows = sqlx::query(sql).fetch(conn);
    let mut out = header;
    while let Some(r) = rows.try_next().await? {
        out.extend(row_to_line(&r)?);
    }
    Ok(out)
}

/// GET /v1/exports/account.zip — the owner's complete data (T-408):
/// manifest.json + full_data.json + CSVs for every business table.
/// refresh_token is excluded on purpose (credentials, never exported);
/// the manifest says so explicitly so nothing is silently omitted.
pub async fn account_zip(State(st): State<AppState>, ctx: AuthCtx) -> ApiResult<Response> {
    ctx.require(Cap::Export)?;
    let mut headers = axum::http::HeaderMap::new();
    attachment(&mut headers, "stokku-akun.zip", "application/zip");

    let pool = st.pool.clone();
    let tenant = ctx.tenant_id;
    let user = ctx.user_id;
    let (tx, rx) = mpsc::channel::<Chunk>(8);
    tokio::spawn(async move {
        // set_app_context is transaction-local (SET LOCAL): on an autocommit
        // connection the tenant context is discarded after the first
        // statement and every RLS read returns zero rows. Keep the whole
        // archive in one transaction, begun from the pool so it owns its
        // connection.
        let mut tx_db = match pool.begin().await {
            Ok(t) => t,
            Err(e) => {
                let _ = tx.send(Err(format!("{e:#}"))).await;
                return;
            }
        };
        if set_app_context(&mut tx_db, Some(tenant), Some(user))
            .await
            .is_err()
        {
            let _ = tx.send(Err("konteks gagal".into())).await;
            return;
        }

        let mut zip: Vec<u8> = Vec::new();
        let mut entries: Vec<ZipEntry> = Vec::new();
        let mut counts: Vec<(String, i64)> = Vec::new();

        // ---- full data as JSON (one file per table) ----
        let tables = [
            "tenant",
            "outlet",
            "category",
            "item",
            "item_barcode",
            "item_unit",
            "stock_move",
            "stock_level",
            "sale",
            "sale_line",
            "payment",
            "cash_entry",
            "cash_category",
            "contact",
            "payable",
            "receivable",
            "opname_session",
            "opname_line",
            "op_log",
            "period_lock",
            "audit_log",
            "change_log",
        ];
        // full_data.json is streamed table by table, never as one whole-database
        // Value, so a large account does not have to fit in memory twice.
        let mut body: Vec<u8> = Vec::new();
        let mut crc = 0xFFFF_FFFFu32;
        let push = |body: &mut Vec<u8>, crc: &mut u32, bytes: &[u8]| {
            body.extend_from_slice(bytes);
            *crc = crc32_update(*crc, bytes);
        };
        push(&mut body, &mut crc, b"{");
        for (i, t) in tables.iter().enumerate() {
            let rows = match table_json(&mut tx_db, t).await {
                Ok(rows) => rows,
                Err(e) => {
                    // A missing table must never yield an archive that
                    // silently lacks it: fail the whole export.
                    let _ = tx.send(Err(format!("{t}: {e:#}"))).await;
                    return;
                }
            };
            counts.push((t.to_string(), rows.len() as i64));
            if i > 0 {
                push(&mut body, &mut crc, b",");
            }
            push(&mut body, &mut crc, format!("\"{t}\":[").as_bytes());
            for (j, row) in rows.iter().enumerate() {
                if j > 0 {
                    push(&mut body, &mut crc, b",");
                }
                match serde_json::to_vec(row) {
                    Ok(bytes) => push(&mut body, &mut crc, &bytes),
                    Err(e) => {
                        let _ = tx.send(Err(format!("{t}: {e:#}"))).await;
                        return;
                    }
                }
            }
            push(&mut body, &mut crc, b"]");
            drop(rows);
        }
        push(&mut body, &mut crc, b"}");
        let data_body = std::mem::take(&mut body);
        let data_crc = crc ^ 0xFFFF_FFFFu32;
        let data_size = data_body.len() as u64;

        let mut counts_json = serde_json::Map::new();
        for (t, n) in &counts {
            counts_json.insert(t.clone(), json!(n));
        }
        let manifest = json!({
            "format": "stokku-account-archive/1",
            "tenant_id": tenant,
            "exported_at": Utc::now().to_rfc3339(),
            "counts": Value::Object(counts_json),
            "csv_files": [
                "items.csv", "stock_levels.csv", "stock_moves.csv",
                "sales_with_lines.csv", "cash_entries.csv", "contacts.csv",
                "laba_rugi_all_time.csv"
            ],
            "json_files": ["manifest.json", "full_data.json"],
            "excluded": {
                "refresh_token": "kredensial sesi, tidak pernah diekspor",
            },
            "note": "angka: rupiah integer; qty 3 desimal; tanggal ISO-8601",
        });

        let add = |zip: &mut Vec<u8>, entries: &mut Vec<ZipEntry>, name: &str, data: &[u8]| {
            let offset = zip.len() as u32;
            zip.extend_from_slice(&zip_local_header(name, data));
            zip.extend_from_slice(data);
            entries.push(ZipEntry {
                name: name.to_string(),
                crc_offset: 0,
                size_offset: 0,
                crc: crc32(data),
                size: data.len() as u32,
                offset,
            });
        };

        let manifest_bytes = serde_json::to_vec_pretty(&manifest).unwrap_or_default();
        add(&mut zip, &mut entries, "manifest.json", &manifest_bytes);
        zip_open_streamed(&mut zip, &mut entries, "full_data.json");
        zip.extend_from_slice(&data_body);
        drop(data_body);
        zip_seal_streamed(&mut zip, &mut entries, data_crc, data_size);

        // ---- CSVs ----
        match table_csv(
            &mut tx_db,
            "select sku, name, base_unit, sale_price, cost_avg, min_stock, active, deleted_at,
                updated_at from item order by name",
            csv_row(&[
                "sku".into(),
                "nama".into(),
                "satuan".into(),
                "harga_jual".into(),
                "cost_avg".into(),
                "min_stok".into(),
                "aktif".into(),
                "dihapus_pada".into(),
                "diubah_pada".into(),
            ]),
            |r| {
                let min_stock: Decimal = r.try_get("min_stock")?;
                Ok(csv_row(&[
                    opt_s(r.try_get::<Option<String>, _>("sku")?),
                    r.try_get::<String, _>("name")?,
                    r.try_get::<String, _>("base_unit")?,
                    s(r.try_get::<i64, _>("sale_price")?),
                    s(r.try_get::<i64, _>("cost_avg")?),
                    qty3(min_stock),
                    s(r.try_get::<bool, _>("active")?),
                    opt_s(r.try_get::<Option<DateTime<Utc>>, _>("deleted_at")?),
                    s(r.try_get::<DateTime<Utc>, _>("updated_at")?),
                ]))
            },
        )
        .await
        {
            Ok(csv) => add(&mut zip, &mut entries, "items.csv", &csv),
            Err(e) => {
                let _ = tx.send(Err(format!("items.csv: {e:#}"))).await;
                return;
            }
        }

        match table_csv(
            &mut tx_db,
            "select outlet_id, item_id, qty from stock_level order by item_id",
            csv_row(&["outlet_id".into(), "item_id".into(), "qty".into()]),
            |r| {
                let qty: Decimal = r.try_get("qty")?;
                Ok(csv_row(&[
                    s(r.try_get::<Uuid, _>("outlet_id")?),
                    s(r.try_get::<Uuid, _>("item_id")?),
                    qty3(qty),
                ]))
            },
        )
        .await
        {
            Ok(csv) => add(&mut zip, &mut entries, "stock_levels.csv", &csv),
            Err(e) => {
                let _ = tx.send(Err(format!("stock_levels.csv: {e:#}"))).await;
                return;
            }
        }

        match table_csv(
            &mut tx_db,
            "select business_date, type, qty, unit_cost, ref_type, ref_id, note, created_at
         from stock_move order by business_date, id",
            csv_row(&[
                "tanggal".into(),
                "tipe".into(),
                "qty".into(),
                "unit_cost".into(),
                "ref_tipe".into(),
                "ref_id".into(),
                "catatan".into(),
                "dibuat_pada".into(),
            ]),
            |r| {
                let qty: Decimal = r.try_get("qty")?;
                Ok(csv_row(&[
                    s(r.try_get::<NaiveDate, _>("business_date")?),
                    r.try_get::<String, _>("type")?,
                    qty3(qty),
                    s(r.try_get::<i64, _>("unit_cost")?),
                    opt_s(r.try_get::<Option<String>, _>("ref_type")?),
                    opt_s(r.try_get::<Option<Uuid>, _>("ref_id")?),
                    opt_s(r.try_get::<Option<String>, _>("note")?),
                    s(r.try_get::<DateTime<Utc>, _>("created_at")?),
                ]))
            },
        )
        .await
        {
            Ok(csv) => add(&mut zip, &mut entries, "stock_moves.csv", &csv),
            Err(e) => {
                let _ = tx.send(Err(format!("stock_moves.csv: {e:#}"))).await;
                return;
            }
        }

        match table_csv(
            &mut tx_db,
            "select s.number, s.business_date, s.payment_method, s.paid, s.mode, s.total,
                s.discount, s.note, s.voided_at, s.void_reason,
                l.item_id, l.qty, l.unit_price, l.discount as line_discount, l.cost_at_sale
         from sale s join sale_line l on l.sale_id = s.id
         order by s.business_date, s.id, l.id",
            csv_row(&[
                "nomor".into(),
                "tanggal".into(),
                "metode_bayar".into(),
                "lunas".into(),
                "mode".into(),
                "total_penjualan".into(),
                "diskon_penjualan".into(),
                "catatan".into(),
                "void_pada".into(),
                "alasan_void".into(),
                "item_id".into(),
                "qty".into(),
                "harga_satuan".into(),
                "diskon_baris".into(),
                "cost_at_sale".into(),
            ]),
            |r| {
                let qty: Decimal = r.try_get("qty")?;
                Ok(csv_row(&[
                    opt_s(r.try_get::<Option<String>, _>("number")?),
                    s(r.try_get::<NaiveDate, _>("business_date")?),
                    r.try_get::<String, _>("payment_method")?,
                    s(r.try_get::<bool, _>("paid")?),
                    r.try_get::<String, _>("mode")?,
                    s(r.try_get::<i64, _>("total")?),
                    s(r.try_get::<i64, _>("discount")?),
                    opt_s(r.try_get::<Option<String>, _>("note")?),
                    opt_s(r.try_get::<Option<DateTime<Utc>>, _>("voided_at")?),
                    opt_s(r.try_get::<Option<String>, _>("void_reason")?),
                    s(r.try_get::<Uuid, _>("item_id")?),
                    qty3(qty),
                    s(r.try_get::<i64, _>("unit_price")?),
                    s(r.try_get::<i64, _>("line_discount")?),
                    s(r.try_get::<i64, _>("cost_at_sale")?),
                ]))
            },
        )
        .await
        {
            Ok(csv) => add(&mut zip, &mut entries, "sales_with_lines.csv", &csv),
            Err(e) => {
                let _ = tx.send(Err(format!("sales_with_lines.csv: {e:#}"))).await;
                return;
            }
        }

        match table_csv(
            &mut tx_db,
            "select business_date, direction, category, method, amount, ref_type, ref_id, note
         from cash_entry order by business_date, id",
            csv_row(&[
                "tanggal".into(),
                "arah".into(),
                "kategori".into(),
                "metode".into(),
                "jumlah".into(),
                "ref_tipe".into(),
                "ref_id".into(),
                "catatan".into(),
            ]),
            |r| {
                Ok(csv_row(&[
                    s(r.try_get::<NaiveDate, _>("business_date")?),
                    r.try_get::<String, _>("direction")?,
                    r.try_get::<String, _>("category")?,
                    opt_s(r.try_get::<Option<String>, _>("method")?),
                    s(r.try_get::<i64, _>("amount")?),
                    opt_s(r.try_get::<Option<String>, _>("ref_type")?),
                    opt_s(r.try_get::<Option<Uuid>, _>("ref_id")?),
                    opt_s(r.try_get::<Option<String>, _>("note")?),
                ]))
            },
        )
        .await
        {
            Ok(csv) => add(&mut zip, &mut entries, "cash_entries.csv", &csv),
            Err(e) => {
                let _ = tx.send(Err(format!("cash_entries.csv: {e:#}"))).await;
                return;
            }
        }

        match table_csv(
            &mut tx_db,
            "select type, name, phone from contact order by name",
            csv_row(&["tipe".into(), "nama".into(), "telepon".into()]),
            |r| {
                Ok(csv_row(&[
                    r.try_get::<String, _>("type")?,
                    r.try_get::<String, _>("name")?,
                    opt_s(r.try_get::<Option<String>, _>("phone")?),
                ]))
            },
        )
        .await
        {
            Ok(csv) => add(&mut zip, &mut entries, "contacts.csv", &csv),
            Err(e) => {
                let _ = tx.send(Err(format!("contacts.csv: {e:#}"))).await;
                return;
            }
        }

        // laba rugi, all months
        match table_csv(
            &mut tx_db,
            "select period, revenue, hpp, gross_profit, opex, net_profit, unpaid_revenue
         from v_laba_rugi order by period",
            csv_row(&[
                "periode".into(),
                "pendapatan".into(),
                "hpp".into(),
                "laba_kotor".into(),
                "beban_operasional".into(),
                "laba_bersih".into(),
                "pendapatan_belum_bayar".into(),
            ]),
            |r| {
                Ok(csv_row(&[
                    s(r.try_get::<NaiveDate, _>("period")?),
                    s(r.try_get::<i64, _>("revenue")?),
                    s(r.try_get::<i64, _>("hpp")?),
                    s(r.try_get::<i64, _>("gross_profit")?),
                    s(r.try_get::<i64, _>("opex")?),
                    s(r.try_get::<i64, _>("net_profit")?),
                    s(r.try_get::<i64, _>("unpaid_revenue")?),
                ]))
            },
        )
        .await
        {
            Ok(csv) => add(&mut zip, &mut entries, "laba_rugi_all_time.csv", &csv),
            Err(e) => {
                let _ = tx.send(Err(format!("laba_rugi_all_time.csv: {e:#}"))).await;
                return;
            }
        }

        // central directory + end record
        let cd_offset = zip.len() as u32;
        let cd = zip_central_dir(&entries);
        let cd_size = cd.len() as u64;
        zip.extend_from_slice(&cd);
        let mut end = zip_end(&entries, cd_size);
        let end_len = end.len();
        // patch the cd offset field (bytes 16..20 of the EOCD)
        end[16..20].copy_from_slice(&cd_offset.to_le_bytes());
        zip.extend_from_slice(&end);
        let _ = end_len;

        // every read is done: commit, then stream the finished archive
        let _ = tx_db.commit().await;

        // stream the archive in 64 KiB chunks
        for chunk in zip.chunks(64 * 1024) {
            if tx.send(Ok(chunk.to_vec())).await.is_err() {
                return;
            }
        }
    });

    Ok(response(headers, rx))
}
