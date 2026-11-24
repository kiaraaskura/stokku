use chrono::{Datelike, NaiveDate};
use serde::Deserialize;
use serde_json::{json, Value};

use axum::extract::{Query, State};
use axum::Json;

use crate::ctx::{AuthCtx, Cap};
use crate::error::{ApiError, ApiResult};
use crate::state::AppState;
use crate::util::{begin_tx, parse_date, today_jakarta};

#[derive(Deserialize)]
pub struct LabaRugiQuery {
    pub from: Option<String>,
    pub to: Option<String>,
    pub compare: Option<bool>,
}

struct Totals {
    revenue: i64,
    hpp: i64,
    unpaid_revenue: i64,
    opex: i64,
}

impl Totals {
    fn gross_profit(&self) -> i64 {
        self.revenue - self.hpp
    }
    fn net_profit(&self) -> i64 {
        self.revenue - self.hpp - self.opex
    }
}

async fn totals_for(
    tx: &mut sqlx::PgConnection,
    from: NaiveDate,
    to: NaiveDate,
) -> ApiResult<Totals> {
    // revenue (accrual: unpaid credit sales count, voided sales do not)
    let (revenue, unpaid): (i64, i64) = sqlx::query_as(
        "select coalesce(sum(total), 0)::bigint,
                coalesce(sum(total) filter (where not paid), 0)::bigint
         from sale
         where voided_at is null and business_date between $1 and $2",
    )
    .bind(from)
    .bind(to)
    .fetch_one(&mut *tx)
    .await?;

    // hpp: qty × cost_at_sale over non-voided per_item sales
    let hpp: i64 = sqlx::query_scalar(
        "select coalesce(sum(l.qty * l.cost_at_sale), 0)::bigint
         from sale s
         join sale_line l on l.sale_id = s.id
         where s.voided_at is null and s.business_date between $1 and $2",
    )
    .bind(from)
    .bind(to)
    .fetch_one(&mut *tx)
    .await?;

    // opex: cash out, excluding stock purchases ('pembelian_stok', 'modal',
    // purchase-linked) — "stok bukan beban"
    let opex: i64 = sqlx::query_scalar(
        "select coalesce(sum(amount), 0)::bigint
         from cash_entry
         where direction = 'out'
           and business_date between $1 and $2
           and category not in ('pembelian_stok', 'modal')
           and coalesce(ref_type, '') not in ('purchase', 'stock_move')",
    )
    .bind(from)
    .bind(to)
    .fetch_one(&mut *tx)
    .await?;

    Ok(Totals {
        revenue,
        hpp,
        unpaid_revenue: unpaid,
        opex,
    })
}

fn default_range() -> (NaiveDate, NaiveDate) {
    let today = today_jakarta();
    let from = NaiveDate::from_ymd_opt(today.year(), today.month(), 1)
        .unwrap_or(today);
    let to = next_month_first(from) - chrono::Duration::days(1);
    (from, to)
}

fn next_month_first(d: NaiveDate) -> NaiveDate {
    let (y, m) = if d.month() == 12 {
        (d.year() + 1, 1)
    } else {
        (d.year(), d.month() + 1)
    };
    NaiveDate::from_ymd_opt(y, m, 1).unwrap_or(d)
}

fn totals_json(t: &Totals) -> Value {
    json!({
        "revenue": t.revenue,
        "hpp": t.hpp,
        "gross_profit": t.gross_profit(),
        "opex": t.opex,
        "net_profit": t.net_profit(),
        "unpaid_revenue": t.unpaid_revenue,
    })
}

/// GET /v1/reports/laba-rugi?from=&to=&compare=true — owner only.
/// Laba rugi definition is fixed: revenue − hpp − opex = net_profit;
/// stock purchases are inventory, not expense.
pub async fn laba_rugi(
    State(st): State<AppState>,
    ctx: AuthCtx,
    Query(q): Query<LabaRugiQuery>,
) -> ApiResult<Json<Value>> {
    ctx.require(Cap::ReportRead)?;
    ctx.require(Cap::CostRead)?;

    let (from, to) = match (q.from.as_deref(), q.to.as_deref()) {
        (Some(f), Some(t)) => (parse_date(f)?, parse_date(t)?),
        (None, None) => default_range(),
        _ => return Err(ApiError::validation("from dan to harus dikirim bersama")),
    };
    if from > to {
        return Err(ApiError::validation("from harus sebelum to"));
    }

    let mut tx = begin_tx(&st.pool, &ctx).await?;
    let t = totals_for(&mut tx, from, to).await?;

    let mut v = json!({
        "from": from,
        "to": to,
        "lines": [
            { "key": "revenue", "label": "Pendapatan", "amount": t.revenue, "drill": "revenue" },
            { "key": "hpp", "label": "HPP (harga pokok penjualan)", "amount": t.hpp, "drill": "hpp" },
            { "key": "gross_profit", "label": "Laba kotor", "amount": t.gross_profit() },
            { "key": "opex", "label": "Beban operasional", "amount": t.opex, "drill": "opex" },
            { "key": "net_profit", "label": "Laba bersih", "amount": t.net_profit() },
            { "key": "unpaid_revenue", "label": "Pendapatan belum dibayar", "amount": t.unpaid_revenue },
        ],
    });
    let base = totals_json(&t);
    for (k, val) in base.as_object().into_iter().flatten() {
        v[k] = val.clone();
    }

    if q.compare.unwrap_or(false) {
        let days = (to - from).num_days() + 1;
        let cmp_to = from - chrono::Duration::days(1);
        let cmp_from = cmp_to - chrono::Duration::days(days - 1);
        let cmp = totals_for(&mut tx, cmp_from, cmp_to).await?;
        v["comparison"] = json!({
            "from": cmp_from,
            "to": cmp_to,
            "revenue": cmp.revenue,
            "hpp": cmp.hpp,
            "gross_profit": cmp.gross_profit(),
            "opex": cmp.opex,
            "net_profit": cmp.net_profit(),
            "unpaid_revenue": cmp.unpaid_revenue,
        });
    }

    tx.commit().await?;
    Ok(Json(v))
}

#[derive(Deserialize)]
pub struct DrillQuery {
    pub line: Option<String>,
    pub from: Option<String>,
    pub to: Option<String>,
}

/// GET /v1/reports/laba-rugi/drill?line=revenue|hpp|opex
pub async fn drill(
    State(st): State<AppState>,
    ctx: AuthCtx,
    Query(q): Query<DrillQuery>,
) -> ApiResult<Json<Value>> {
    ctx.require(Cap::ReportRead)?;
    ctx.require(Cap::CostRead)?;

    let line = q
        .line
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| ApiError::validation_field("Parameter line wajib diisi", "line", "revenue | hpp | opex"))?;
    if !matches!(line, "revenue" | "hpp" | "opex") {
        return Err(ApiError::validation_field(
            "line harus revenue, hpp, atau opex",
            "line",
            "revenue | hpp | opex",
        ));
    }
    let (from, to) = match (q.from.as_deref(), q.to.as_deref()) {
        (Some(f), Some(t)) => (parse_date(f)?, parse_date(t)?),
        (None, None) => default_range(),
        _ => return Err(ApiError::validation("from dan to harus dikirim bersama")),
    };

    let mut tx = begin_tx(&st.pool, &ctx).await?;
    let data = match line {
        "revenue" => {
            let rows: Vec<(uuid::Uuid, Option<String>, NaiveDate, i64, bool, bool)> = sqlx::query_as(
                "select id, number, business_date, total, paid, mode
                 from sale
                 where voided_at is null and business_date between $1 and $2
                 order by business_date, id",
            )
            .bind(from)
            .bind(to)
            .fetch_all(&mut *tx)
            .await?;
            rows.iter()
                .map(|(id, number, date, total, paid, mode)| {
                    json!({
                        "sale_id": id, "number": number, "business_date": date,
                        "total": total, "paid": paid, "mode": mode,
                        "unpaid": !paid,
                    })
                })
                .collect::<Vec<_>>()
        }
        "hpp" => {
            let rows: Vec<(uuid::Uuid, Option<String>, NaiveDate, String, rust_decimal::Decimal, i64)> = sqlx::query_as(
                "select s.id, s.number, s.business_date, i.name, l.qty, l.cost_at_sale
                 from sale s
                 join sale_line l on l.sale_id = s.id
                 join item i on i.id = l.item_id
                 where s.voided_at is null and s.business_date between $1 and $2
                 order by s.business_date, s.id, l.id",
            )
            .bind(from)
            .bind(to)
            .fetch_all(&mut *tx)
            .await?;
            rows.iter()
                .map(|(id, number, date, name, qty, cost)| {
                    json!({
                        "sale_id": id, "number": number, "business_date": date,
                        "item": name, "qty": crate::util::qty_json(qty),
                        "cost_at_sale": cost,
                        "amount": crate::util::dec_to_rupiah(&(*qty * rust_decimal::Decimal::from(*cost))),
                    })
                })
                .collect::<Vec<_>>()
        }
        _ => {
            let rows: Vec<(uuid::Uuid, NaiveDate, String, i64, Option<String>)> = sqlx::query_as(
                "select id, business_date, category, amount, note
                 from cash_entry
                 where direction = 'out'
                   and business_date between $1 and $2
                   and category not in ('pembelian_stok', 'modal')
                   and coalesce(ref_type, '') not in ('purchase', 'stock_move')
                 order by business_date, id",
            )
            .bind(from)
            .bind(to)
            .fetch_all(&mut *tx)
            .await?;
            rows.iter()
                .map(|(id, date, cat, amount, note)| {
                    json!({
                        "cash_entry_id": id, "business_date": date,
                        "category": cat, "amount": amount, "note": note,
                    })
                })
                .collect::<Vec<_>>()
        }
    };
    tx.commit().await?;
    Ok(Json(json!({ "line": line, "from": from, "to": to, "data": data, "next_cursor": null })))
}
