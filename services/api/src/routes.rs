pub mod cash;
pub mod categories;
pub mod items;
pub mod reports;
pub mod sales;

use axum::routing::{delete, get, post};
use axum::Router;

use crate::{auth, state::AppState};

async fn health(axum::extract::State(st): axum::extract::State<AppState>) -> impl axum::response::IntoResponse {
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
        .route(
            "/v1/items",
            get(items::list).post(items::create),
        )
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
        .route(
            "/v1/cash-entries",
            get(cash::list).post(cash::create),
        )
        .route("/v1/cash-entries/{id}", delete(cash::reversal_delete))
        .route("/v1/cash-categories", get(cash::categories))
        .route("/v1/sales", get(sales::list).post(sales::create))
        .route("/v1/sales/{id}", get(sales::get_one))
        .route("/v1/sales/{id}/void", post(sales::void))
        .route("/v1/reports/laba-rugi", get(reports::laba_rugi))
        .route("/v1/reports/laba-rugi/drill", get(reports::drill))
        .with_state(state)
}
