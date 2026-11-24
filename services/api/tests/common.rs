//! Shared harness for DB-backed integration tests.
//! (kept as a macro-free module copied into each test binary — tests are
//! separate crates; kept small enough that duplication is fine)

use sqlx::postgres::PgPoolOptions;
use sqlx::PgPool;

pub fn admin_url() -> Option<String> {
    std::env::var("STOKKU_TEST_ADMIN_URL")
        .ok()
        .filter(|s| !s.is_empty())
}

fn base_url() -> String {
    let base = admin_url().expect("STOKKU_TEST_ADMIN_URL");
    let base = base.trim_end_matches('/');
    let base = base.strip_suffix("/postgres").unwrap_or(base);
    // strip the user: postgres://user@host:port -> postgres://host:port
    match base.split_once("://") {
        Some((scheme, rest)) => match rest.rsplit_once('@') {
            Some((_, host)) => format!("{scheme}://{host}"),
            None => base.to_string(),
        },
        None => base.to_string(),
    }
}

/// The non-superuser app role (compose model: bootstrap superuser migrates,
/// the app connects as `stokku`, so forced RLS binds it for real).
fn app_url(dbname: &str) -> String {
    format!("postgres://stokku@{}/{dbname}", host_port())
}

fn host_port() -> String {
    let base = base_url();
    let rest = base.split_once("://").map(|x| x.1).unwrap_or(&base);
    rest.to_string()
}

/// Create a fresh database, migrate as the superuser (0010 needs it),
/// grant the app role its privileges, and return a pool connected as the
/// non-superuser app role.
pub async fn fresh_db(tag: &str) -> PgPool {
    let admin = admin_url().expect("STOKKU_TEST_ADMIN_URL");
    let admin = admin.trim_end_matches('/');
    let admin = admin.strip_suffix("/postgres").unwrap_or(admin);
    let dbname = format!("stokku_{tag}_{}", uuid::Uuid::now_v7().simple());

    let superpool = PgPoolOptions::new()
        .max_connections(2)
        .connect(&format!("{admin}/postgres"))
        .await
        .expect("connect admin");
    sqlx::query(&format!("drop database if exists {dbname}"))
        .execute(&superpool)
        .await
        .expect("drop db");
    sqlx::query(&format!("create database {dbname}"))
        .execute(&superpool)
        .await
        .expect("create db");
    superpool.close().await;

    // migrate + grant as the superuser
    let dbpool = PgPoolOptions::new()
        .max_connections(2)
        .connect(&format!("{admin}/{dbname}"))
        .await
        .expect("connect fresh db as superuser");
    stokku_api::migrator()
        .await
        .expect("load migrations")
        .run(&dbpool)
        .await
        .expect("migrate (0010 needs a superuser runner)");
    for grant in [
        "grant usage on schema public to stokku",
        "grant select, insert, update, delete on all tables in schema public to stokku",
        "grant usage, select on all sequences in schema public to stokku",
        "grant execute on all functions in schema public to stokku",
    ] {
        sqlx::query(grant).execute(&dbpool).await.expect("grant");
    }
    dbpool.close().await;

    PgPoolOptions::new()
        .max_connections(5)
        .connect(&app_url(&dbname))
        .await
        .expect("connect as app role")
}

pub async fn drop_db(pool: PgPool) {
    let dbname = pool.connect_options().get_database().unwrap_or("").to_string();
    pool.close().await;
    let Some(admin) = admin_url() else { return };
    let admin = admin.trim_end_matches('/');
    let admin = admin.strip_suffix("/postgres").unwrap_or(admin);
    if let Ok(p) = PgPoolOptions::new()
        .max_connections(1)
        .connect(&format!("{admin}/postgres"))
        .await
    {
        let _ = sqlx::query(&format!("drop database if exists {dbname} with (force)"))
            .execute(&p)
            .await;
        p.close().await;
    }
}
