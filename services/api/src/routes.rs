pub mod cash;
pub mod categories;
pub mod contacts;
pub mod exports;
pub mod items;
pub mod opname;
pub mod qris;
pub mod reports;
pub mod sales;
pub mod sync;

use axum::routing::{delete, get, post};
use axum::Router;

use crate::{auth, state::AppState};

async fn health(
    axum::extract::State(st): axum::extract::State<AppState>,
) -> impl axum::response::IntoResponse {
    let db_up = sqlx::query_scalar::<_, i32>("select 1")
        .fetch_one(&st.pool)
        .await
        .is_ok();
    let body = serde_json::json!({
        "status": if db_up { "ok" } else { "error" },
        "build": st.cfg.build_hash,
        "db": { "status": if db_up { "up" } else { "down" } },
    });
    let code = if db_up {
        axum::http::StatusCode::OK
    } else {
        axum::http::StatusCode::SERVICE_UNAVAILABLE
    };
    (code, axum::Json(body))
}

pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/health", get(health))
        .route("/v1/auth/signup", post(auth::signup))
        .route("/v1/auth/login", post(auth::login))
        .route("/v1/auth/refresh", post(auth::refresh))
        .route("/v1/auth/logout", post(auth::logout))
        .route("/v1/me", get(auth::me))
        .route("/v1/items", get(items::list).post(items::create))
        .route("/v1/items/search", get(items::search))
        .route(
            "/v1/items/{id}",
            get(items::get_one)
                .patch(items::update)
                .delete(items::soft_delete),
        )
        .route("/v1/items/{id}/ledger", get(items::ledger))
        .route(
            "/v1/categories",
            get(categories::list).post(categories::create),
        )
        .route(
            "/v1/stock-moves",
            get(crate::stock::list).post(crate::stock::create),
        )
        .route(
            "/v1/stock-moves/preview-reverse/{id}",
            post(crate::stock::preview_reverse),
        )
        .route("/v1/stock-moves/{id}/reverse", post(crate::stock::reverse))
        .route("/v1/cash-entries", get(cash::list).post(cash::create))
        .route("/v1/cash-entries/{id}", delete(cash::reversal_delete))
        .route("/v1/cash-categories", get(cash::categories))
        .route("/v1/contacts", get(contacts::list).post(contacts::create))
        .route(
            "/v1/contacts/{id}",
            axum::routing::patch(contacts::update).delete(contacts::remove),
        )
        .route(
            "/v1/payables",
            get(contacts::list_payables).post(contacts::create_payable),
        )
        .route("/v1/payables/{id}/payments", post(contacts::pay_payable))
        .route(
            "/v1/receivables",
            get(contacts::list_receivables).post(contacts::create_receivable),
        )
        .route(
            "/v1/receivables/{id}/payments",
            post(contacts::pay_receivable),
        )
        .route("/v1/sales", get(sales::list).post(sales::create))
        .route("/v1/sales/{id}", get(sales::get_one))
        .route("/v1/sales/{id}/void", post(sales::void))
        .route("/v1/sales/{id}/qris/confirm", post(qris::confirm))
        .route(
            "/v1/outlets/{id}/qris",
            get(qris::get_settings).put(qris::put_settings),
        )
        .route("/v1/exports/sales.csv", get(exports::sales_csv))
        .route("/v1/exports/stock.csv", get(exports::stock_csv))
        .route("/v1/exports/stock-moves.csv", get(exports::stock_moves_csv))
        .route("/v1/exports/cash.csv", get(exports::cash_csv))
        .route("/v1/exports/laba-rugi.csv", get(exports::laba_rugi_csv))
        .route("/v1/exports/laba-rugi.html", get(exports::laba_rugi_html))
        .route("/v1/exports/opname/{id}", get(exports::opname_html))
        .route("/v1/exports/account.zip", get(exports::account_zip))
        .route("/v1/sync/push", post(sync::push))
        .route("/v1/sync/pull", get(sync::pull))
        .route("/v1/opname", post(opname::create))
        .route("/v1/opname/{id}", get(opname::get_one))
        .route(
            "/v1/opname/{id}/lines",
            axum::routing::patch(opname::patch_lines),
        )
        .route("/v1/opname/{id}/post", post(opname::post))
        .route("/v1/reports/stock", get(reports::stock_report))
        .route("/v1/reports/sales", get(reports::sales_report))
        .route("/v1/reports/dashboard", get(reports::dashboard))
        .route("/v1/reports/laba-rugi", get(reports::laba_rugi))
        .route("/v1/reports/laba-rugi/drill", get(reports::drill))
        .with_state(state)
}
