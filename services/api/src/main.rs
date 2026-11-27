use stokku_api::{config::AppConfig, routes, state::AppState};

#[tokio::main]
async fn main() {
    let cfg = AppConfig::from_env();

    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()),
        )
        .init();

    let pool = sqlx::postgres::PgPoolOptions::new()
        .max_connections(10)
        .connect(&cfg.database_url)
        .await
        .unwrap_or_else(|e| panic!("DATABASE_URL tidak bisa dipakai: {e}"));

    let state = AppState::new(pool, cfg.clone());

    let cors = cors_layer();
    let app = routes::router(state)
        .layer(tower_http::trace::TraceLayer::new_for_http())
        .layer(cors);

    let listener = tokio::net::TcpListener::bind(&cfg.bind_addr)
        .await
        .unwrap_or_else(|e| panic!("tidak bisa bind {}: {e}", cfg.bind_addr));

    tracing::info!(
        build = cfg.build_hash,
        addr = cfg.bind_addr,
        "stokku-api listening"
    );

    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await
        .expect("server error");
}

/// CORS for the configured web origins only. `APP_BASE_URL` is the web
/// origin; `CORS_ORIGINS` adds LAN extras. Never `*`: a token-authorized API
/// reachable from the Wi-Fi must not be callable by an arbitrary website.
fn cors_layer() -> tower_http::cors::CorsLayer {
    use axum::http::{header, HeaderValue, Method};
    use tower_http::cors::{AllowOrigin, CorsLayer};

    let allowed: Vec<HeaderValue> = stokku_api::config::cors_origins_from_env()
        .iter()
        .filter_map(|o| HeaderValue::from_str(o).ok())
        .collect();
    CorsLayer::new()
        .allow_origin(AllowOrigin::list(allowed))
        .allow_methods([
            Method::GET,
            Method::POST,
            Method::PATCH,
            Method::DELETE,
            Method::OPTIONS,
        ])
        .allow_headers([header::AUTHORIZATION, header::CONTENT_TYPE])
        .max_age(std::time::Duration::from_secs(600))
}

async fn shutdown_signal() {
    let ctrl_c = async {
        tokio::signal::ctrl_c().await.expect("ctrl_c");
    };
    #[cfg(unix)]
    let terminate = async {
        tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .expect("signal handler")
            .recv()
            .await;
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        () = ctrl_c => {},
        () = terminate => {},
    }
    tracing::info!("shutdown signal diterima, menutup koneksi");
}
