//! Stokku API — inventory + cash book for Indonesian UMKM.
//!
//! One binary, axum 0.8 + sqlx 0.8 with **runtime** queries only
//! (no compile-time `sqlx::query!` macros, per docs/WORKSPLIT.md §1.4).

pub mod auth;
pub mod config;
pub mod ctx;
pub mod error;
pub mod routes;
pub mod state;
pub mod stock;
pub mod util;

/// Migrations are owned by the DB member (docs/DATA_MODEL.md). Loaded at
/// runtime from the directory (file embedding only — no compile-time DB
/// coupling, and the `macros` feature of sqlx stays off on purpose).
pub async fn migrator() -> Result<sqlx::migrate::Migrator, sqlx::migrate::MigrateError> {
    sqlx::migrate::Migrator::new(std::path::Path::new(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/migrations"
    )))
    .await
}
