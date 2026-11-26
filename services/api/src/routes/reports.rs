use chrono::{Datelike, NaiveDate};
use rust_decimal::Decimal;
use sqlx::Row;
use uuid::Uuid;

use crate::util::{begin_tx, parse_date, qty_json};
use serde::Deserialize;
use serde_json::{json, Value};

use axum::extract::{Query, State};
use axum::Json;

use crate::ctx::{AuthCtx, Cap};
use crate::error::{ApiError, ApiResult};
use crate::state::AppState;
use crate::util::today_jakarta;

#[derive(Deserialize)]
pub struct LabaRugiQuery {
    pub from: Option<String>,
    pub to: Option<String>,
    pub compare: Option<bool>,
}

pub struct Totals {
    pub revenue: i64,
    pub hpp: i64,
    pub unpaid_revenue: i64,
    pub opex: i64,
    pub qris_mdr_fee: i64,
}

impl Totals {
    pub fn gross_profit(&self) -> i64 {
        self.revenue - self.hpp
    }
    pub fn net_profit(&self) -> i64 {
        self.revenue - self.hpp - self.opex
    }
}

pub async fn totals_for_tx(
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

    // QRIS MDR fee, shown separately from gross revenue (D20):
    // paid payments on non-voided sales in the window
    let qris_mdr_fee: i64 = sqlx::query_scalar(
        "select coalesce(sum(p.mdr_amount), 0)::bigint
         from payment p
         join sale s on s.id = p.sale_id
         where p.status = 'paid'
           and p.mdr_amount > 0
           and s.voided_at is null
           and s.business_date between $1 and $2",
    )
    .bind(from)
    .bind(to)
    .fetch_one(&mut *tx)
    .await?;

    // opex: cash out, excluding stock purchases ('pembelian_stok', 'modal',
    // purchase-linked) — "stok bukan beban" — and sale money, which is revenue,
    // not an expense: a paid sale's cash-in and its void reversal
    // (ref_type 'sale' / 'sale_void') are both excluded. Mirrors v_opex (0015).
    let opex: i64 = sqlx::query_scalar(
        "select coalesce(sum(amount), 0)::bigint
         from cash_entry
         where direction = 'out'
           and business_date between $1 and $2
           and category not in ('pembelian_stok', 'modal')
           and coalesce(ref_type, '') not in ('purchase', 'stock_move', 'sale', 'sale_void')",
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
        qris_mdr_fee,
    })
}

fn default_range() -> (NaiveDate, NaiveDate) {
    let today = today_jakarta();
    let from = NaiveDate::from_ymd_opt(today.year(), today.month(), 1).unwrap_or(today);
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
        "qris_mdr_fee": t.qris_mdr_fee,
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
    let t = totals_for_tx(&mut tx, from, to).await?;

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
            { "key": "qris_mdr_fee", "label": "Biaya MDR QRIS (dipisah dari pendapatan kotor)", "amount": t.qris_mdr_fee },
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
        let cmp = totals_for_tx(&mut tx, cmp_from, cmp_to).await?;
        v["comparison"] = json!({
            "from": cmp_from,
            "to": cmp_to,
            "revenue": cmp.revenue,
            "hpp": cmp.hpp,
            "gross_profit": cmp.gross_profit(),
            "opex": cmp.opex,
            "net_profit": cmp.net_profit(),
            "unpaid_revenue": cmp.unpaid_revenue,
            "qris_mdr_fee": cmp.qris_mdr_fee,
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
        .ok_or_else(|| {
            ApiError::validation_field("Parameter line wajib diisi", "line", "revenue | hpp | opex")
        })?;
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
            let rows: Vec<(uuid::Uuid, Option<String>, NaiveDate, i64, bool, String)> =
                sqlx::query_as(
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
            let rows: Vec<(
                uuid::Uuid,
                Option<String>,
                NaiveDate,
                String,
                rust_decimal::Decimal,
                i64,
            )> = sqlx::query_as(
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
                   and coalesce(ref_type, '') not in ('purchase', 'stock_move', 'sale', 'sale_void')
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
    Ok(Json(
        json!({ "line": line, "from": from, "to": to, "data": data, "next_cursor": null }),
    ))
}

// ---------------------------------------------------------------- T-403/404/405 --
// Sprint-2 report screens, reading DB's 0013 views (security_invoker).

#[derive(Deserialize)]
pub struct StockReportQuery {
    pub outlet_id: Option<Uuid>,
}

/// GET /v1/reports/stock?outlet_id= — per outlet+item valuation.
pub async fn stock_report(
    State(st): State<AppState>,
    ctx: AuthCtx,
    Query(q): Query<StockReportQuery>,
) -> ApiResult<Json<Value>> {
    ctx.require(Cap::ReportRead)?;
    ctx.require(Cap::CostRead)?;

    let mut tx = begin_tx(&st.pool, &ctx).await?;
    let outlet_id = match q.outlet_id {
        Some(o) => o,
        None => crate::util::default_outlet_id(&mut tx).await?,
    };

    let rows = sqlx::query(
        "select item_id, item_name, sku, category_id, qty, cost_avg, sale_price,
                value_at_cost, value_at_sale, low_stock, negative_stock,
                last_movement_date, dead_stock, move_count_90d, move_count
         from v_stock_report
         where outlet_id = $1
         order by value_at_cost desc nulls last",
    )
    .bind(outlet_id)
    .fetch_all(&mut *tx)
    .await?;
    tx.commit().await?;

    let row_json = |r: &sqlx::postgres::PgRow| -> ApiResult<Value> {
        let qty: Decimal = r.try_get("qty")?;
        let at_cost: Decimal = r.try_get("value_at_cost")?;
        let at_sale: Decimal = r.try_get("value_at_sale")?;
        Ok(json!({
            "item_id": r.try_get::<Uuid, _>("item_id")?,
            "item_name": r.try_get::<String, _>("item_name")?,
            "sku": r.try_get::<Option<String>, _>("sku")?,
            "category_id": r.try_get::<Option<Uuid>, _>("category_id")?,
            "outlet_id": outlet_id,
            "qty": qty_json(&qty),
            "cost_avg": r.try_get::<i64, _>("cost_avg")?,
            "sale_price": r.try_get::<i64, _>("sale_price")?,
            "value_at_cost": qty_json(&at_cost),
            "value_at_sale": qty_json(&at_sale),
            "low_stock": r.try_get::<bool, _>("low_stock")?,
            "negative_stock": r.try_get::<bool, _>("negative_stock")?,
            "last_movement_date": r.try_get::<Option<NaiveDate>, _>("last_movement_date")?,
            "dead_stock": r.try_get::<bool, _>("dead_stock")?,
            "move_count_90d": r.try_get::<i64, _>("move_count_90d")?,
            "move_count": r.try_get::<i64, _>("move_count")?,
        }))
    };

    let data: Vec<Value> = rows.iter().map(row_json).collect::<ApiResult<Vec<_>>>()?;
    let at_cost: Decimal = rows
        .iter()
        .map(|r| r.try_get::<Decimal, _>("value_at_cost"))
        .collect::<Result<Vec<_>, _>>()
        .unwrap_or_default()
        .iter()
        .sum();
    let at_sale: Decimal = rows
        .iter()
        .map(|r| r.try_get::<Decimal, _>("value_at_sale"))
        .collect::<Result<Vec<_>, _>>()
        .unwrap_or_default()
        .iter()
        .sum();
    let low_stock: Vec<&Value> = data
        .iter()
        .filter(|v| v["low_stock"].as_bool().unwrap_or(false))
        .collect();
    let dead_stock: Vec<&Value> = data
        .iter()
        .filter(|v| v["dead_stock"].as_bool().unwrap_or(false))
        .collect();

    Ok(Json(json!({
        "outlet_id": outlet_id,
        "at_cost": crate::util::dec_to_rupiah(&at_cost),
        "at_sale": crate::util::dec_to_rupiah(&at_sale),
        "low_stock_count": low_stock.len(),
        "dead_stock_count": dead_stock.len(),
        "low_stock": low_stock,
        "dead_stock": dead_stock,
        "data": data,
        "next_cursor": null,
    })))
}

#[derive(Deserialize)]
pub struct SalesReportQuery {
    pub from: Option<String>,
    pub to: Option<String>,
    pub group_by: Option<String>,
}

/// GET /v1/reports/sales?from=&to=&group_by=day|item|category
pub async fn sales_report(
    State(st): State<AppState>,
    ctx: AuthCtx,
    Query(q): Query<SalesReportQuery>,
) -> ApiResult<Json<Value>> {
    ctx.require(Cap::ReportRead)?;
    let group_by = q.group_by.as_deref().unwrap_or("day");
    if !matches!(group_by, "day" | "item" | "category") {
        return Err(ApiError::validation_field(
            "group_by tidak valid",
            "group_by",
            "day | item | category",
        ));
    }
    let (from, to) = match (q.from.as_deref(), q.to.as_deref()) {
        (Some(f), Some(t)) => (parse_date(f)?, parse_date(t)?),
        (None, None) => default_range(),
        _ => return Err(ApiError::validation("from dan to harus dikirim bersama")),
    };

    let mut tx = begin_tx(&st.pool, &ctx).await?;

    let data: Vec<Value> = match group_by {
        "day" => {
            let rows: Vec<(NaiveDate, Decimal, i64, i64, i64)> = sqlx::query_as(
                "select day, sum(revenue), sum(sale_count)::bigint,
                        sum(daily_total_count)::bigint, sum(line_count)::bigint
                 from v_sales_report
                 where dimension = 'day' and day between $1 and $2
                 group by day order by day",
            )
            .bind(from)
            .bind(to)
            .fetch_all(&mut *tx)
            .await?;
            rows.iter()
                .map(
                    |(day, revenue, sale_count, daily_total_count, line_count)| {
                        json!({
                            "day": day,
                            "revenue": crate::util::dec_to_rupiah(revenue),
                            "sale_count": sale_count,
                            "daily_total_count": daily_total_count,
                            "line_count": line_count,
                        })
                    },
                )
                .collect()
        }
        "item" => {
            let rows: Vec<(Uuid, String, Option<String>, Decimal, i64, i64)> = sqlx::query_as(
                "select r.item_id, i.name, i.sku, sum(r.revenue),
                        sum(r.sale_count)::bigint, sum(r.line_count)::bigint
                 from v_sales_report r
                 join item i on i.id = r.item_id
                 where r.dimension = 'item' and r.day between $1 and $2
                 group by r.item_id, i.name, i.sku
                 order by sum(r.revenue) desc",
            )
            .bind(from)
            .bind(to)
            .fetch_all(&mut *tx)
            .await?;
            rows.iter()
                .map(|(item_id, name, sku, revenue, sale_count, line_count)| {
                    json!({
                        "item_id": item_id,
                        "item_name": name,
                        "sku": sku,
                        "revenue": crate::util::dec_to_rupiah(revenue),
                        "sale_count": sale_count,
                        "line_count": line_count,
                    })
                })
                .collect()
        }
        _ => {
            type CatRow = (Option<Uuid>, Option<String>, Decimal, i64, i64);
            let rows: Vec<CatRow> = sqlx::query_as(
                "select r.category_id, c.name, sum(r.revenue),
                        sum(r.sale_count)::bigint, sum(r.line_count)::bigint
                 from v_sales_report r
                 left join category c on c.id = r.category_id
                 where r.dimension = 'category' and r.day between $1 and $2
                 group by r.category_id, c.name
                 order by sum(r.revenue) desc",
            )
            .bind(from)
            .bind(to)
            .fetch_all(&mut *tx)
            .await?;
            rows.iter()
                .map(|(category_id, name, revenue, sale_count, line_count)| {
                    json!({
                        "category_id": category_id,
                        "category_name": name.clone().unwrap_or_else(|| "Tanpa kategori".into()),
                        "revenue": crate::util::dec_to_rupiah(revenue),
                        "sale_count": sale_count,
                        "line_count": line_count,
                    })
                })
                .collect()
        }
    };
    tx.commit().await?;

    Ok(Json(json!({
        "from": from,
        "to": to,
        "group_by": group_by,
        "data": data,
        "next_cursor": null,
    })))
}

#[derive(Deserialize)]
pub struct DashboardQuery {
    pub outlet_id: Option<Uuid>,
}

/// GET /v1/reports/dashboard?outlet_id= — today's sales, cash position,
/// low-stock count, month profit (reuses v_laba_rugi via v_dashboard).
pub async fn dashboard(
    State(st): State<AppState>,
    ctx: AuthCtx,
    Query(q): Query<DashboardQuery>,
) -> ApiResult<Json<Value>> {
    ctx.require(Cap::ReportRead)?;
    ctx.require(Cap::CostRead)?;

    let mut tx = begin_tx(&st.pool, &ctx).await?;
    let outlet_id = match q.outlet_id {
        Some(o) => o,
        None => crate::util::default_outlet_id(&mut tx).await?,
    };
    let row = sqlx::query(
        "select day, today_sales, cash_position, low_stock_count, month_profit
         from v_dashboard where outlet_id = $1",
    )
    .bind(outlet_id)
    .fetch_optional(&mut *tx)
    .await?;
    tx.commit().await?;

    let row = row.ok_or_else(|| ApiError::NotFound("Outlet tidak ditemukan".into()))?;
    let today_sales: Decimal = row.try_get("today_sales")?;
    let cash_position: Decimal = row.try_get("cash_position")?;
    let month_profit: i64 = row.try_get("month_profit")?;

    Ok(Json(json!({
        "outlet_id": outlet_id,
        "day": row.try_get::<NaiveDate, _>("day")?,
        "today_sales": crate::util::dec_to_rupiah(&today_sales),
        "cash_position": crate::util::dec_to_rupiah(&cash_position),
        "low_stock_count": row.try_get::<i64, _>("low_stock_count")?,
        "month_profit": month_profit,
    })))
}
